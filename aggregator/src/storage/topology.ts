import { existsSync, readFileSync } from 'node:fs';

export interface StoreMember {
    name: string;   // pod/StatefulSet name, e.g. mongo-s1-a
    host: string;
    node: string;   // kubectl node name the member is pinned to
    arbiter: boolean;
}
export interface StoreUnit {
    name: string;   // shard / logical unit name reported in Audit API (shard-1, ...)
    members: StoreMember[];
}
export interface StoreTopology {
    units: StoreUnit[];
}

// Written by scripts/k8s/store-topology.sh into ConfigMap store-topology (layout + real node names).
export function loadTopology(): StoreTopology | undefined {
    const inline = process.env.STORE_TOPOLOGY;
    if (inline) return JSON.parse(inline) as StoreTopology;
    const file = process.env.STORE_TOPOLOGY_FILE ?? '/etc/store/topology.json';
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as StoreTopology;
    return undefined;
}
