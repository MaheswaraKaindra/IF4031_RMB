import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { Collection, Db, Document } from 'mongodb';
import { bookkeepingOptions } from '../storage/health.js';

export interface LeaseResult {
    acquired: boolean;
    holder: string | null;
    serverNowMs: number;
    renewTimeMs: number | null;
}

export interface ILeaseProvider {
    tryAcquireOrRenew(leaseName: string, identity: string, leaseDurationMs: number): Promise<LeaseResult>;
    release?(leaseName: string, identity: string): Promise<void>;
}

/** Formats epoch milliseconds as RFC3339 MicroTime (6 fractional digits) required by K8s Lease API. */
export function toK8sMicroTime(ms: number): string {
    const iso = new Date(ms).toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
    return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

interface K8sLeaseObject {
    apiVersion: 'coordination.k8s.io/v1';
    kind: 'Lease';
    metadata: {
        name: string;
        namespace: string;
        resourceVersion?: string;
    };
    spec?: {
        holderIdentity?: string;
        leaseDurationSeconds?: number;
        acquireTime?: string;
        renewTime?: string;
        leaseTransitions?: number;
    };
}

export interface KubernetesLeaseOptions {
    namespace?: string | undefined;
    host?: string | undefined;
    port?: number | undefined;
    tokenPath?: string | undefined;
    caPath?: string | undefined;
    requestTimeoutMs?: number | undefined;
    observer?: LeaseObserver | undefined;
}

/**
 * Kubernetes coordination.k8s.io/v1 Lease client using the API server HTTP Date header
 * as the single authoritative clock so local node wall-clock skew cannot forge or steal leases.
 */
/**
 * Decides whether a lease has expired WITHOUT comparing wall clocks. A lease is expired when this process has not seen the
 * lease object change for its whole duration, measured with this process's own monotonic clock (the rule client-go's leader
 * election uses). Comparing the lease's renewTime with an API server's `Date` header is unsafe here: every k3s node runs an
 * API server and the in-cluster Service reaches any of them, so one node with a drifted clock (+45 s, -30 s) gives different
 * instances different ideas of "now" and makes leadership flap (measured: 10 leadership changes in 3 minutes).
 * A lease with no holder is expired at once (a clean release hands over immediately).
 */
export class LeaseObserver {
    private readonly seen = new Map<string, { key: string; at: number }>();
    constructor(private readonly nowMono: () => number = () => performance.now()) {}

    isExpired(leaseName: string, key: string, hasHolder: boolean, durationMs: number): boolean {
        const now = this.nowMono();
        const cur = this.seen.get(leaseName);
        if (!cur || cur.key !== key) this.seen.set(leaseName, { key, at: now });
        if (!hasHolder) return true;
        return now - (this.seen.get(leaseName)?.at ?? now) > durationMs;
    }
}

export class KubernetesLeaseProvider implements ILeaseProvider {
    private readonly namespace: string;
    private readonly host: string;
    private readonly port: number;
    private readonly tokenPath: string;
    private readonly ca: Buffer;
    private readonly timeoutMs: number;
    private readonly observer: LeaseObserver;

    constructor(opts: KubernetesLeaseOptions = {}) {
        this.namespace =
            opts.namespace ??
            process.env.POD_NAMESPACE ??
            readTrimmed('/var/run/secrets/kubernetes.io/serviceaccount/namespace', 'sistem-informasi-kebencanaan-bnpb');
        this.host = opts.host ?? process.env.KUBERNETES_SERVICE_HOST ?? 'kubernetes.default.svc';
        this.port = opts.port ?? Number(process.env.KUBERNETES_SERVICE_PORT ?? 443);
        this.tokenPath = opts.tokenPath ?? '/var/run/secrets/kubernetes.io/serviceaccount/token';
        this.ca = readFileSync(opts.caPath ?? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');
        this.timeoutMs = opts.requestTimeoutMs ?? 3000;
        this.observer = opts.observer ?? new LeaseObserver();
    }

    private request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T; serverNowMs: number }> {
        const token = readFileSync(this.tokenPath, 'utf8').trim();
        const payload = body === undefined ? undefined : JSON.stringify(body);
        return new Promise((resolve, reject) => {
            const req = https.request(
                {
                    host: this.host,
                    port: this.port,
                    path,
                    method,
                    ca: this.ca,
                    timeout: this.timeoutMs,
                    headers: {
                        Authorization: `Bearer ${token}`,
                        Accept: 'application/json',
                        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
                    },
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        const dateHeader = res.headers['date'];
                        const parsedDate = typeof dateHeader === 'string' ? Date.parse(dateHeader) : Number.NaN;
                        const serverNowMs = Number.isNaN(parsedDate) ? Date.now() : parsedDate;
                        const text = Buffer.concat(chunks).toString('utf8');
                        let parsed: unknown = {};
                        try {
                            parsed = text.length > 0 ? JSON.parse(text) : {};
                        } catch {
                            parsed = { raw: text };
                        }
                        resolve({ status: res.statusCode ?? 500, data: parsed as T, serverNowMs });
                    });
                }
            );
            req.on('timeout', () => req.destroy(new Error(`K8s Lease API ${method} ${path} timed out`)));
            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    async tryAcquireOrRenew(leaseName: string, identity: string, leaseDurationMs: number): Promise<LeaseResult> {
        const durationSec = Math.max(1, Math.ceil(leaseDurationMs / 1000));
        const basePath = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.namespace)}/leases`;
        const itemPath = `${basePath}/${encodeURIComponent(leaseName)}`;

        const got = await this.request<K8sLeaseObject>('GET', itemPath);
        if (got.status === 404) {
            const nowIso = toK8sMicroTime(got.serverNowMs);
            const created = await this.request<K8sLeaseObject>('POST', basePath, {
                apiVersion: 'coordination.k8s.io/v1',
                kind: 'Lease',
                metadata: { name: leaseName, namespace: this.namespace },
                spec: {
                    holderIdentity: identity,
                    leaseDurationSeconds: durationSec,
                    acquireTime: nowIso,
                    renewTime: nowIso,
                    leaseTransitions: 0,
                },
            });
            if (created.status >= 200 && created.status < 300) {
                return {
                    acquired: true,
                    holder: identity,
                    serverNowMs: created.serverNowMs,
                    renewTimeMs: created.serverNowMs,
                };
            }
            if (created.status === 409) {
                return { acquired: false, holder: null, serverNowMs: created.serverNowMs, renewTimeMs: null };
            }
            throw new Error(`K8s Lease POST failed with status ${created.status}`);
        }

        if (got.status < 200 || got.status >= 300) {
            throw new Error(`K8s Lease GET failed with status ${got.status}`);
        }

        const existing = got.data;
        const spec = existing.spec ?? {};
        const currentHolder = spec.holderIdentity ?? null;
        const existingDurationMs = (spec.leaseDurationSeconds ?? durationSec) * 1000;
        const existingRenewMs = spec.renewTime ? Date.parse(spec.renewTime) : Number.NaN;
        // Expiry from what THIS process has observed (monotonic), never from the difference of two wall clocks.
        const expired = this.observer.isExpired(
            leaseName,
            `${currentHolder ?? ''}|${spec.renewTime ?? ''}|${existing.metadata.resourceVersion ?? ''}`,
            Boolean(currentHolder),
            existingDurationMs,
        );

        if (currentHolder && currentHolder !== identity && !expired) {
            return {
                acquired: false,
                holder: currentHolder,
                serverNowMs: got.serverNowMs,
                renewTimeMs: Number.isNaN(existingRenewMs) ? null : existingRenewMs,
            };
        }

        const isTakeover = currentHolder !== identity;
        const nowIso = toK8sMicroTime(got.serverNowMs);
        const updated = await this.request<K8sLeaseObject>('PUT', itemPath, {
            apiVersion: 'coordination.k8s.io/v1',
            kind: 'Lease',
            metadata: {
                name: leaseName,
                namespace: this.namespace,
                resourceVersion: existing.metadata.resourceVersion,
            },
            spec: {
                holderIdentity: identity,
                leaseDurationSeconds: durationSec,
                acquireTime: isTakeover ? nowIso : spec.acquireTime ?? nowIso,
                renewTime: nowIso,
                leaseTransitions: (spec.leaseTransitions ?? 0) + (isTakeover ? 1 : 0),
            },
        });

        if (updated.status >= 200 && updated.status < 300) {
            return {
                acquired: true,
                holder: identity,
                serverNowMs: updated.serverNowMs,
                renewTimeMs: updated.serverNowMs,
            };
        }
        if (updated.status === 409) {
            return { acquired: false, holder: currentHolder, serverNowMs: updated.serverNowMs, renewTimeMs: null };
        }
        throw new Error(`K8s Lease PUT failed with status ${updated.status}`);
    }

    async release(leaseName: string, identity: string): Promise<void> {
        const itemPath = `/apis/coordination.k8s.io/v1/namespaces/${encodeURIComponent(this.namespace)}/leases/${encodeURIComponent(leaseName)}`;
        try {
            const got = await this.request<K8sLeaseObject>('GET', itemPath);
            if (got.status !== 200 || got.data.spec?.holderIdentity !== identity) return;
            await this.request('PUT', itemPath, {
                ...got.data,
                spec: {
                    ...got.data.spec,
                    holderIdentity: '',
                    renewTime: toK8sMicroTime(got.serverNowMs - (got.data.spec?.leaseDurationSeconds ?? 20) * 1000 - 1000),
                },
            });
        } catch {
            // Best effort release during shutdown
        }
    }
}

interface MongoLeaseDoc {
    _id: string;
    holder_identity: string;
    expires_at: Date;
    updated_at: Date;
}

/**
 * MongoDB-backed lease provider using MongoDB's authoritative server clock ($currentDate / hello.localTime)
 * for non-Kubernetes environments (e.g. Docker Compose / local tests).
 */
export class MongoLeaseProvider implements ILeaseProvider {
    constructor(private readonly getDb: () => Db, private readonly collectionName = 'coordination_leases') {}

    private coll(): Collection<MongoLeaseDoc> {
        return this.getDb().collection<MongoLeaseDoc>(this.collectionName, bookkeepingOptions());
    }

    private async serverNowMs(): Promise<number> {
        const res = (await this.getDb().command({ hello: 1 })) as Document;
        return res['localTime'] instanceof Date ? res['localTime'].getTime() : Date.now();
    }

    async tryAcquireOrRenew(leaseName: string, identity: string, leaseDurationMs: number): Promise<LeaseResult> {
        const nowMs = await this.serverNowMs();
        const now = new Date(nowMs);
        const expiresAt = new Date(nowMs + leaseDurationMs);

        try {
            const doc = await this.coll().findOneAndUpdate(
                {
                    _id: leaseName,
                    $or: [{ holder_identity: identity }, { expires_at: { $lte: now } }, { holder_identity: '' }],
                },
                {
                    $set: { holder_identity: identity, expires_at: expiresAt, updated_at: now },
                },
                { upsert: true, returnDocument: 'after' }
            );
            if (doc && doc.holder_identity === identity) {
                return { acquired: true, holder: identity, serverNowMs: nowMs, renewTimeMs: nowMs };
            }
        } catch (err) {
            if (!isDupKey(err)) throw err;
        }

        const current = await this.coll().findOne({ _id: leaseName });
        return {
            acquired: false,
            holder: current?.holder_identity || null,
            serverNowMs: nowMs,
            renewTimeMs: current?.updated_at?.getTime() ?? null,
        };
    }

    async release(leaseName: string, identity: string): Promise<void> {
        try {
            await this.coll().updateOne(
                { _id: leaseName, holder_identity: identity },
                { $set: { holder_identity: '', expires_at: new Date(0) } }
            );
        } catch {
            // Best effort
        }
    }
}

export class InMemoryLeaseProvider implements ILeaseProvider {
    private readonly leases = new Map<string, { holder: string; renewTimeMs: number; durationMs: number }>();
    public clockMs = Date.UTC(2026, 10, 18, 12, 0, 0);

    async tryAcquireOrRenew(leaseName: string, identity: string, leaseDurationMs: number): Promise<LeaseResult> {
        const now = this.clockMs;
        const cur = this.leases.get(leaseName);
        if (!cur || cur.holder === identity || cur.holder === '' || now - cur.renewTimeMs > cur.durationMs) {
            this.leases.set(leaseName, { holder: identity, renewTimeMs: now, durationMs: leaseDurationMs });
            return { acquired: true, holder: identity, serverNowMs: now, renewTimeMs: now };
        }
        return { acquired: false, holder: cur.holder, serverNowMs: now, renewTimeMs: cur.renewTimeMs };
    }

    async release(leaseName: string, identity: string): Promise<void> {
        const cur = this.leases.get(leaseName);
        if (cur && cur.holder === identity) this.leases.delete(leaseName);
    }
}

function readTrimmed(path: string, fallback: string): string {
    try {
        return readFileSync(path, 'utf8').trim() || fallback;
    } catch {
        return fallback;
    }
}

function isDupKey(err: unknown): boolean {
    return typeof err === 'object' && err !== null && 'code' in err && (err as { code: unknown }).code === 11000;
}
