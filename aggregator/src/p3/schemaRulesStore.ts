import type { Db } from 'mongodb';
import { bookkeepingOptions } from '../storage/health.js';
import { defaultSchemaRules, type SchemaRulesConfig } from './schemaValidator.js';

/**
 * The PVMBG schema rules decide whether a parked message can be recovered, so every aggregator replica must apply the
 * same ones and they must survive a restart. They live in the Canonical Store (one small document). Each pod keeps a cached
 * copy that it refreshes every few seconds and before every replay, so a rule saved through any pod reaches the leader's
 * live ingest and the retry worker on all pods.
 */
export interface RulesDoc {
    rules: SchemaRulesConfig;
    version: number;
}

export interface RulesBackend {
    read(): Promise<RulesDoc | null>;
    /** Replaces the document; the version only moves forward. */
    write(doc: RulesDoc): Promise<void>;
}

export function applyRulesPatch(current: SchemaRulesConfig, body: Partial<SchemaRulesConfig>): SchemaRulesConfig {
    const enabled = body.enablePvmbgV2Compat ?? current.enablePvmbgV2Compat;
    return {
        enablePvmbgV2Compat: enabled,
        // The validator applies the aliases whenever they exist, so turning the rule OFF must remove them (otherwise a renamed field stays accepted for good
        // after the first time the rule was on: found when a rename was no longer parked in the P3 check).
        fieldAliases:
            body.fieldAliases ??
            (body.enablePvmbgV2Compat === undefined ? current.fieldAliases : enabled ? { mountain_code: 'volcano_id', status_level: 'alert_level' } : {}),
        coerceNumericStrings: body.coerceNumericStrings ?? (body.enablePvmbgV2Compat ?? current.coerceNumericStrings),
        defaults: body.defaults ?? current.defaults,
    };
}

export class SchemaRulesStore {
    private cached: SchemaRulesConfig;
    private version = 0;
    private timer: NodeJS.Timeout | undefined;

    constructor(
        private readonly backend: RulesBackend,
        initial: SchemaRulesConfig = defaultSchemaRules()
    ) {
        this.cached = initial;
    }

    /** Synchronous read for the hot ingest path. */
    current(): SchemaRulesConfig {
        return this.cached;
    }

    /** Loads the shared copy. A store outage keeps the last known rules instead of failing the ingest. */
    async refresh(): Promise<boolean> {
        try {
            const doc = await this.backend.read();
            if (doc && doc.version >= this.version) {
                this.cached = doc.rules;
                this.version = doc.version;
            }
            return true;
        } catch {
            return false;
        }
    }

    /** Persists first, then switches the local copy; a failed write leaves the rules unchanged and throws. */
    async update(patch: Partial<SchemaRulesConfig>): Promise<SchemaRulesConfig> {
        await this.refresh();
        const rules = applyRulesPatch(this.cached, patch);
        const next: RulesDoc = { rules, version: this.version + 1 };
        await this.backend.write(next);
        this.cached = rules;
        this.version = next.version;
        return rules;
    }

    start(intervalMs = 2000): void {
        if (this.timer) return;
        void this.refresh();
        this.timer = setInterval(() => void this.refresh(), intervalMs);
        this.timer.unref?.();
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
    }
}

interface RulesMongoDoc extends RulesDoc {
    _id: string;
    updated_at: string;
}

export class MongoRulesBackend implements RulesBackend {
    constructor(
        private readonly getDb: () => Db,
        private readonly collectionName = 'ops_config',
        private readonly id = 'pvmbg_schema_rules'
    ) {}

    private coll() {
        return this.getDb().collection<RulesMongoDoc>(this.collectionName, bookkeepingOptions());
    }

    async read(): Promise<RulesDoc | null> {
        const doc = await this.coll().findOne({ _id: this.id });
        return doc ? { rules: doc.rules, version: doc.version } : null;
    }

    async write(doc: RulesDoc): Promise<void> {
        // Never move the version backwards when two pods save at the same time: the later version wins.
        await this.coll().updateOne(
            { _id: this.id, $or: [{ version: { $lt: doc.version } }, { version: { $exists: false } }] },
            { $set: { rules: doc.rules, version: doc.version, updated_at: new Date().toISOString() } },
            { upsert: false }
        ).then(async (res) => {
            if (res.matchedCount > 0) return;
            try {
                await this.coll().insertOne({ _id: this.id, rules: doc.rules, version: doc.version, updated_at: new Date().toISOString() });
            } catch (err) {
                // Another pod created the document first: the version it holds is at least as new, keep it.
                if ((err as { code?: number }).code !== 11000) throw err;
            }
        });
    }
}

export class InMemoryRulesBackend implements RulesBackend {
    doc: RulesDoc | null = null;
    failing = false;

    async read(): Promise<RulesDoc | null> {
        if (this.failing) throw new Error('store unavailable');
        return this.doc ? { rules: this.doc.rules, version: this.doc.version } : null;
    }

    async write(doc: RulesDoc): Promise<void> {
        if (this.failing) throw new Error('store unavailable');
        if (!this.doc || this.doc.version < doc.version) this.doc = { rules: doc.rules, version: doc.version };
    }
}
