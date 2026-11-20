export type SensorHealth = 'fresh' | 'stale' | 'frozen_clock' | 'unknown';

export interface FreshnessOptions {
    staleLagMs: number; // generated_at minus newest observed_at, in sensor time
    stationSilenceMs: number; // sensor time
    frozenAfterWallMs: number; // generated_at unchanged for this long on the wall clock
}

export const DEFAULT_FRESHNESS: FreshnessOptions = {
    staleLagMs: 120_000,
    stationSilenceMs: 300_000,
    frozenAfterWallMs: 5_000,
};

export interface FreshnessReport {
    health: SensorHealth;
    lagMs: number | null;
    silentStations: string[];
}

// Judges the sensor only by its own clock (generated_at against observed_at), so it does not depend on the
// profile speed or on this machine's clock. /healthz is never consulted: it only proves readiness.
export class SensorFreshness {
    private newestObservedMs: number | null = null;
    private readonly stationLast = new Map<string, number>();
    private lastGeneratedMs: number | null = null;
    private generatedChangedAtWall = 0;

    constructor(
        private readonly opts: FreshnessOptions = DEFAULT_FRESHNESS,
        private readonly knownStations: () => Iterable<string> = () => [],
    ) {}

    reset(): void {
        this.newestObservedMs = null;
        this.stationLast.clear();
        this.lastGeneratedMs = null;
    }

    recordObservation(stationId: string, observedMs: number): void {
        if (this.newestObservedMs === null || observedMs > this.newestObservedMs) this.newestObservedMs = observedMs;
        if (observedMs > (this.stationLast.get(stationId) ?? 0)) this.stationLast.set(stationId, observedMs);
    }

    // isTail: the response reached the end of the observation log. Lag during a catch-up page is not a fault.
    evaluate(generatedMs: number | null, isTail: boolean, wallNowMs: number): FreshnessReport {
        if (generatedMs === null) return { health: 'unknown', lagMs: null, silentStations: [] };
        if (this.lastGeneratedMs === null || generatedMs !== this.lastGeneratedMs) {
            this.lastGeneratedMs = generatedMs;
            this.generatedChangedAtWall = wallNowMs;
        } else if (wallNowMs - this.generatedChangedAtWall >= this.opts.frozenAfterWallMs) {
            return { health: 'frozen_clock', lagMs: null, silentStations: [] };
        }
        if (!isTail || this.newestObservedMs === null) return { health: 'fresh', lagMs: null, silentStations: [] };
        const lagMs = generatedMs - this.newestObservedMs;
        const silent: string[] = [];
        for (const id of this.knownStations()) {
            const last = this.stationLast.get(id);
            if (last !== undefined && generatedMs - last > this.opts.stationSilenceMs) silent.push(id);
        }
        return { health: lagMs > this.opts.staleLagMs ? 'stale' : 'fresh', lagMs, silentStations: silent };
    }
}
