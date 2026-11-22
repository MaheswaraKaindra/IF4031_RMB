/**
 * The poll cursor is the time of the previous fetch, taken from the poller's OWN clock, and the upstream returns events with a time at or
 * after it. A poller whose clock runs ahead (the clock-shift test uses +45 s) would write a cursor in the future and the next poll, by
 * anyone, would skip every upstream event dated between real time and that cursor: a permanent gap. The cursor is therefore never used as is:
 * each poll starts a fixed overlap earlier. The overlap only causes repeats, and a repeat is harmless because the store keeps one record per
 * source_ref_id (outcome `duplicate`). The overlap must exceed the largest clock error to tolerate.
 */
export function sinceWithOverlap(cursorIso: string, overlapMs: number): string {
    const t = Date.parse(cursorIso);
    if (!Number.isFinite(t) || t <= 0 || overlapMs <= 0) return cursorIso;
    return new Date(Math.max(0, t - overlapMs)).toISOString();
}
