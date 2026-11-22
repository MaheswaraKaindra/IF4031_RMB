export type Confidence = 'l' | 'n' | 'h';

export interface Detection {
    key: string; // satellite|acq_date|acq_time|latitude|longitude, taken verbatim from the feed
    satellite: string;
    time_ms: number; // acq_date + acq_time in UTC
    latitude: number;
    longitude: number;
    confidence: Confidence;
    frp_mw: number;
}

export function parseAcquisitionTime(acqDate: string, acqTime: string | number): number {
    const hhmm = String(acqTime).padStart(4, '0');
    const ms = Date.parse(`${acqDate}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
    if (Number.isNaN(ms)) throw new Error(`invalid acquisition time ${acqDate} ${acqTime}`);
    return ms;
}
