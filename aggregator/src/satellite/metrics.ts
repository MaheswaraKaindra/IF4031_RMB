export interface MetricsLike {
    inc(name: string, labels?: Record<string, string>, delta?: number): void;
    set(name: string, labels: Record<string, string>, value: number): void;
    observe(name: string, labels: Record<string, string>, value: number): void;
}
