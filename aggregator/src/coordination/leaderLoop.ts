import type { Logger } from 'pino';
import type { ISourceFenceStore } from './fencing.js';
import type { ILeaseProvider } from './lease.js';

export interface LeaderOptions {
    source: string;
    leaseName: string;
    identity: string;
    leaseDurationMs: number;
    renewDeadlineMs: number;
    retryPeriodMs: number;
    leaseProvider: ILeaseProvider;
    fenceStore: ISourceFenceStore;
    logger: Logger;
    nowMono?: () => number;
    onLeadershipChange?: (state: { isLeader: boolean; epoch: number }) => void;
}

export interface LeaderLeaseHandle {
    epoch: number;
    signal: AbortSignal;
    isStillValid: () => boolean;
}

/**
 * Coordinates single-active-poller ownership per source using an external Lease authority
 * plus a monotonic fencing epoch in the storage engine. Uses a monotonic clock for local
 * renewal deadlines so wall-clock jumps (+45s/-30s) or VM pauses revoke local leadership
 * before a stale instance can issue or commit duplicate work.
 */
export class SourceLeaderManager {
    private readonly nowMono: () => number;
    private isLeader = false;
    private currentEpoch = 0;
    private currentHolder: string | null = null;
    private lastRenewedMonoMs = -Infinity;
    private abortController: AbortController | undefined;
    private timer: NodeJS.Timeout | undefined;
    private stopped = false;
    private stepping = false;

    constructor(private readonly opts: LeaderOptions) {
        this.nowMono = opts.nowMono ?? (() => performance.now());
    }

    start(): void {
        if (this.timer || this.stopped) return;
        void this.step();
        this.timer = setInterval(() => void this.step(), this.opts.retryPeriodMs);
        this.timer.unref();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        const wasLeader = this.isLeader;
        this.revokeLeadership('shutdown');
        if (wasLeader && this.opts.leaseProvider.release) {
            await this.opts.leaseProvider.release(this.opts.leaseName, this.opts.identity);
        }
    }

    getStatus(): { isLeader: boolean; epoch: number; holder: string | null; valid: boolean } {
        return {
            isLeader: this.isLeader,
            epoch: this.currentEpoch,
            holder: this.currentHolder,
            valid: this.isLeadershipValid(),
        };
    }

    /** True only while holding the lease AND within the monotonic renewal deadline (minus optional safety margin). */
    isLeadershipValid(safetyMarginMs = 0): boolean {
        if (!this.isLeader || this.currentEpoch <= 0) return false;
        const elapsed = this.nowMono() - this.lastRenewedMonoMs;
        return elapsed >= 0 && elapsed + safetyMarginMs <= this.opts.renewDeadlineMs;
    }

    /** Returns an active leadership handle (and triggers an immediate renew if close to deadline), or null if follower. */
    async acquirePollHandle(expectedPollMs = 0): Promise<LeaderLeaseHandle | null> {
        if (!this.isLeader) return null;
        if (!this.isLeadershipValid(expectedPollMs)) {
            await this.step();
        }
        if (!this.isLeadershipValid(expectedPollMs) || !this.abortController) return null;
        const epoch = this.currentEpoch;
        return {
            epoch,
            signal: this.abortController.signal,
            isStillValid: () => this.isLeadershipValid() && this.currentEpoch === epoch,
        };
    }

    async step(): Promise<boolean> {
        if (this.stopped || this.stepping) return this.isLeadershipValid();
        this.stepping = true;

        // If we slept/froze past renewDeadline, drop local authority BEFORE talking to the lease API.
        if (this.isLeader && !this.isLeadershipValid()) {
            this.revokeLeadership('renew_deadline_exceeded');
        }

        try {
            const res = await this.opts.leaseProvider.tryAcquireOrRenew(
                this.opts.leaseName,
                this.opts.identity,
                this.opts.leaseDurationMs
            );
            this.currentHolder = res.holder;

            if (!res.acquired) {
                if (this.isLeader) {
                    this.revokeLeadership('lease_lost_to_contender');
                }
                return false;
            }

            const renewMono = this.nowMono();
            if (!this.isLeader) {
                const newEpoch = await this.opts.fenceStore.activateEpoch(this.opts.source, this.opts.identity);
                this.isLeader = true;
                this.currentEpoch = newEpoch;
                this.lastRenewedMonoMs = renewMono;
                this.abortController = new AbortController();
                this.opts.logger.info(
                    { source: this.opts.source, identity: this.opts.identity, leader_epoch: newEpoch },
                    'acquired source leadership'
                );
                this.opts.onLeadershipChange?.({ isLeader: true, epoch: newEpoch });
            } else {
                // Verify the DB epoch hasn't been bumped behind our back while we were renewing.
                const stillMine = await this.opts.fenceStore.assertEpoch(this.opts.source, this.currentEpoch);
                if (!stillMine) {
                    this.revokeLeadership('epoch_superseded');
                    return false;
                }
                this.lastRenewedMonoMs = renewMono;
            }
            return true;
        } catch (err) {
            this.opts.logger.warn(
                { source: this.opts.source, error: err instanceof Error ? err.message : String(err) },
                'lease renew failed'
            );
            if (this.isLeader && !this.isLeadershipValid()) {
                this.revokeLeadership('lease_renew_error_after_deadline');
            }
            return false;
        } finally {
            this.stepping = false;
        }
    }

    private revokeLeadership(reason: string): void {
        if (!this.isLeader) return;
        const oldEpoch = this.currentEpoch;
        this.isLeader = false;
        this.currentEpoch = 0;
        this.lastRenewedMonoMs = -Infinity;
        this.abortController?.abort(new Error(`leadership revoked: ${reason}`));
        this.abortController = undefined;
        this.opts.logger.warn(
            { source: this.opts.source, identity: this.opts.identity, leader_epoch: oldEpoch, reason },
            'revoked source leadership'
        );
        this.opts.onLeadershipChange?.({ isLeader: false, epoch: 0 });
    }
}
