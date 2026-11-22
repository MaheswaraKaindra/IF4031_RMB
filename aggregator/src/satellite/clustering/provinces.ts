import { haversineKm } from './geo.js';

export interface Province {
    name: string;
    latitude: number;
    longitude: number;
}

// Static BNPB reference table: approximate geographic centre of each of the 38 provinces.
export const PROVINCES: readonly Province[] = [
    { name: 'Aceh', latitude: 4.69, longitude: 96.75 },
    { name: 'Sumatera Utara', latitude: 2.19, longitude: 99.38 },
    { name: 'Sumatera Barat', latitude: -0.74, longitude: 100.8 },
    { name: 'Riau', latitude: 0.29, longitude: 101.71 },
    { name: 'Kepulauan Riau', latitude: 3.95, longitude: 108.14 },
    { name: 'Jambi', latitude: -1.61, longitude: 103.61 },
    { name: 'Sumatera Selatan', latitude: -3.32, longitude: 104.91 },
    { name: 'Kepulauan Bangka Belitung', latitude: -2.74, longitude: 106.44 },
    { name: 'Bengkulu', latitude: -3.8, longitude: 102.26 },
    { name: 'Lampung', latitude: -4.56, longitude: 105.41 },
    { name: 'DKI Jakarta', latitude: -6.21, longitude: 106.85 },
    { name: 'Banten', latitude: -6.41, longitude: 106.06 },
    { name: 'Jawa Barat', latitude: -6.92, longitude: 107.6 },
    { name: 'Jawa Tengah', latitude: -7.15, longitude: 110.14 },
    { name: 'DI Yogyakarta', latitude: -7.8, longitude: 110.36 },
    { name: 'Jawa Timur', latitude: -7.54, longitude: 112.24 },
    { name: 'Bali', latitude: -8.34, longitude: 115.09 },
    { name: 'Nusa Tenggara Barat', latitude: -8.65, longitude: 117.36 },
    { name: 'Nusa Tenggara Timur', latitude: -8.66, longitude: 121.08 },
    { name: 'Kalimantan Barat', latitude: -0.28, longitude: 111.48 },
    { name: 'Kalimantan Tengah', latitude: -1.68, longitude: 113.38 },
    { name: 'Kalimantan Selatan', latitude: -3.09, longitude: 115.28 },
    { name: 'Kalimantan Timur', latitude: 0.54, longitude: 116.42 },
    { name: 'Kalimantan Utara', latitude: 3.07, longitude: 116.04 },
    { name: 'Sulawesi Utara', latitude: 0.62, longitude: 123.98 },
    { name: 'Gorontalo', latitude: 0.7, longitude: 122.45 },
    { name: 'Sulawesi Tengah', latitude: -1.43, longitude: 121.45 },
    { name: 'Sulawesi Barat', latitude: -2.84, longitude: 119.23 },
    { name: 'Sulawesi Selatan', latitude: -3.67, longitude: 119.97 },
    { name: 'Sulawesi Tenggara', latitude: -4.14, longitude: 122.17 },
    { name: 'Maluku Utara', latitude: 1.57, longitude: 127.81 },
    { name: 'Maluku', latitude: -3.24, longitude: 130.15 },
    { name: 'Papua Barat', latitude: -1.34, longitude: 133.17 },
    { name: 'Papua Barat Daya', latitude: -0.9, longitude: 131.3 },
    { name: 'Papua', latitude: -2.6, longitude: 139.6 },
    { name: 'Papua Tengah', latitude: -3.8, longitude: 136.2 },
    { name: 'Papua Pegunungan', latitude: -4.2, longitude: 139.2 },
    { name: 'Papua Selatan', latitude: -6.8, longitude: 139.8 },
];

export function nearestProvince(latitude: number, longitude: number): string {
    let best = PROVINCES[0]!;
    let bestKm = Infinity;
    for (const p of PROVINCES) {
        const km = haversineKm(latitude, longitude, p.latitude, p.longitude);
        if (km < bestKm || (km === bestKm && p.name < best.name)) {
            best = p;
            bestKm = km;
        }
    }
    return best.name;
}
