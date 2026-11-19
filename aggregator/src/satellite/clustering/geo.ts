export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_DEG_LAT = 111.19;

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
    const rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad;
    const dLon = (bLon - aLon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}
