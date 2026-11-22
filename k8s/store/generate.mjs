#!/usr/bin/env node
// Generates k8s/store/{members.yaml,init.js,layout.json} from the single placement rule below.
//   node k8s/store/generate.mjs          (no dependencies; commit the output)
//
// Placement (3 nodes, "store slots" 1..3, assigned to real nodes by scripts/m2/label-nodes.sh):
//   shard-i : data member "a" on slot i, data member "b" on slot i%3+1, arbiter on slot (i+1)%3+1
//   cfg     : one config server per slot
// Every node therefore holds data for exactly 2 of the 3 shards (~2/3 of the dataset, never all of it), and
// losing any one node leaves at least one data copy of every shard. See docs/m2/decisions/ADR-0001-storage.md.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SLOTS = 3;
const DB = 'bnpb_canonical_store';
// MongoDB 4.4 is the newest release that runs without AVX (the VirtualBox/Hyper-V guests expose none): see ADR-0001.
// 4.4 ships the legacy `mongo` shell, not mongosh.
const MONGO_IMAGE = 'docker.io/library/mongo:4.4';
const shards = [1, 2, 3].map((i) => ({
    name: `shard-${i}`,
    members: [
        { name: `mongo-s${i}-a`, slot: i, arbiter: false, priority: 2 },
        { name: `mongo-s${i}-b`, slot: (i % SLOTS) + 1, arbiter: false, priority: 1 },
        { name: `mongo-s${i}-arb`, slot: ((i + 1) % SLOTS) + 1, arbiter: true, priority: 0 },
    ],
}));
const config = { name: 'cfg', members: [1, 2, 3].map((s) => ({ name: `mongo-cfg-${s}`, slot: s, arbiter: false, priority: 1 })) };

const layout = { database: DB, slots: SLOTS, config, shards };
writeFileSync(join(here, 'layout.json'), JSON.stringify(layout, null, 2) + '\n');

const STORE_RES = `            requests: {memory: 512Mi}
            limits: {memory: 1Gi}`;

// First start: create the local root user on a throw-away standalone mongod (users replicate once the set forms; a
// secondary's initial sync replaces its copy with the primary's). Then run the real server. --dbpath is explicit because
// a configsvr would otherwise default to /data/configdb, which is NOT the persistent volume.
const BOOT = [
    'set -e', 'DB=/data/db',
    'if [ ! -f $DB/.bnpb-root-user ]; then',
    '  mongod --dbpath $DB --bind_ip 127.0.0.1 --port 27017 --wiredTigerCacheSizeGB 0.25 --fork --logpath /tmp/init.log >/dev/null',
    `  mongo --quiet --port 27017 --eval "try { db.getSiblingDB('admin').createUser({user: _getEnv('MONGO_INITDB_ROOT_USERNAME'), pwd: _getEnv('MONGO_INITDB_ROOT_PASSWORD'), roles: [{role: 'root', db: 'admin'}]}) } catch (e) { if (e.code !== 51003) throw e }"`,
    '  mongod --dbpath $DB --shutdown >/dev/null',
    '  touch $DB/.bnpb-root-user', 'fi',
    'exec mongod --dbpath $DB "$@"',
].join('\n');

function member(m, kind, replSet) {
    const mode = kind === 'config' ? '--configsvr' : '--shardsvr';
    const args = [mode, '--port', '27017', '--replSet', replSet, '--bind_ip_all', '--keyFile', '/keyfile/keyfile',
        '--wiredTigerCacheSizeGB', '0.25', ...(m.arbiter ? [] : ['--oplogSize', '256'])];
    const unit = kind === 'config' ? 'cfg' : replSet;
    // Arbiters hold no data and get no root user. Data members create the local root user themselves (see BOOT): the image
    // entrypoint's own first-start does it with a temporary standalone mongod but keeps --shardsvr/--configsvr, which
    // mongod then refuses ("Cannot start a shardsvr as a standalone server", docker-library/mongo#211).
    const env = m.arbiter ? '' : `          envFrom:
            - secretRef: {name: mongo-secret}
          env:
            - {name: HOME, value: /tmp}
          securityContext: {runAsUser: 999, runAsGroup: 999, allowPrivilegeEscalation: false}
          command: ["bash", "-c", ${JSON.stringify(BOOT)}, "--"]
`;
    const podSec = m.arbiter ? '' : `      securityContext: {fsGroup: 999}
`;
    return `---
apiVersion: v1
kind: Service
metadata:
  name: ${m.name}
  labels: {app.kubernetes.io/name: ${m.name}, role: store, bnpb.io/store: "true"}
spec:
  clusterIP: None
  publishNotReadyAddresses: true   # replica set members must resolve each other before they are Ready
  selector: {app.kubernetes.io/name: ${m.name}}
  ports: [{name: mongo, port: 27017}]
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${m.name}
  labels: {app.kubernetes.io/name: ${m.name}, role: store, bnpb.io/store: "true"}
spec:
  serviceName: ${m.name}
  replicas: 1
  selector:
    matchLabels: {app.kubernetes.io/name: ${m.name}}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${m.name}
        role: store
        bnpb.io/store: "true"
        bnpb.io/unit: ${unit}
        bnpb.io/member-kind: ${m.arbiter ? 'arbiter' : kind}
    spec:
      # Pinned to a node slot: data lives on THAT node's local disk and is not rescheduled elsewhere.
      nodeSelector: {bnpb.io/store-slot: "${m.slot}"}
${podSec}      initContainers:
        - name: copy-keyfile   # mongod requires the keyfile to be owned by mongodb with mode 0400
          image: ${MONGO_IMAGE}
          command: ["sh", "-c", "cp /keyfile-src/keyfile /keyfile/keyfile && chown 999:999 /keyfile/keyfile && chmod 400 /keyfile/keyfile"]
          resources:
${STORE_RES.replace(/^ {12}/gm, '            ')}
          volumeMounts:
            - {name: keyfile-src, mountPath: /keyfile-src, readOnly: true}
            - {name: keyfile, mountPath: /keyfile}
      containers:
        - name: mongod
          image: ${MONGO_IMAGE}
          args: [${args.map((a) => `"${a}"`).join(', ')}]
          ports: [{name: mongo, containerPort: 27017}]
${env}          resources:
${STORE_RES}
          volumeMounts:
            - {name: data, mountPath: /data/db}
            - {name: keyfile, mountPath: /keyfile}
          # TCP probes on purpose: an exec'd mongo shell would run inside this container's 1Gi limit.
          startupProbe:
            tcpSocket: {port: mongo}
            periodSeconds: 5
            failureThreshold: 60
          readinessProbe:
            tcpSocket: {port: mongo}
            periodSeconds: 10
          livenessProbe:
            tcpSocket: {port: mongo}
            periodSeconds: 10
            failureThreshold: 6
      volumes:
        - name: keyfile-src
          secret: {secretName: mongo-keyfile}
        - name: keyfile
          emptyDir: {}
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests: {storage: ${m.arbiter ? '1Gi' : '5Gi'}}
`;
}

let yaml = '# GENERATED by k8s/store/generate.mjs: do not edit by hand.\n';
for (const m of config.members) yaml += member(m, 'config', 'cfg');
for (const s of shards) for (const m of s.members) yaml += member(m, 'shard', s.name);
writeFileSync(join(here, 'members.yaml'), yaml);

// ---- init script (legacy mongo shell) with the layout inlined -------------------------------------------------
const init = `// GENERATED by k8s/store/generate.mjs. Idempotent cluster bootstrap, safe to re-run.
const LAYOUT = ${JSON.stringify(layout)};
const NS = _getEnv('POD_NAMESPACE');
const fqdn = (m) => m + '-0.' + m + '.' + NS + '.svc.cluster.local';
// Direct connection to one host (no replica set discovery), authenticated as the local root user.
const conn = (host) => {
    const c = new Mongo(host + ':27017');
    if (!c.getDB('admin').auth(_getEnv('MONGO_INITDB_ROOT_USERNAME'), _getEnv('MONGO_INITDB_ROOT_PASSWORD'))) throw new Error('auth failed on ' + host);
    return c;
};
function waitFor(what, fn, tries = 150) {
    for (let i = 0; i < tries; i++) {
        try { const v = fn(); if (v) return v; } catch (e) { /* not ready yet */ }
        sleep(2000);
    }
    throw new Error('timed out waiting for ' + what);
}

function ensureReplicaSet(rs) {
    const dataMembers = rs.members.filter((m) => !m.arbiter);
    const first = fqdn(dataMembers[0].name);
    waitFor('reach ' + first, () => conn(first).getDB('admin').runCommand({ ping: 1 }).ok === 1);
    let initiated = false;
    try { initiated = conn(first).getDB('admin').adminCommand({ replSetGetStatus: 1 }).ok === 1; } catch (e) { initiated = false; }
    if (!initiated) {
        const cfg = {
            _id: rs.name,
            ...(rs.name === 'cfg' ? { configsvr: true } : {}),
            members: rs.members.map((m, i) => ({ _id: i, host: fqdn(m.name) + ':27017', priority: m.priority, ...(m.arbiter ? { arbiterOnly: true } : {}) })),
        };
        printjson(conn(first).getDB('admin').adminCommand({ replSetInitiate: cfg }));
    }
    waitFor(rs.name + ' primary', () => {
        const st = conn(first).getDB('admin').adminCommand({ replSetGetStatus: 1 });
        return st.members.some((m) => m.stateStr === 'PRIMARY');
    });
    print('replica set ready: ' + rs.name);
}

function primaryHost(rs) {
    return waitFor(rs.name + ' primary host', () => {
        for (const m of rs.members.filter((x) => !x.arbiter)) {
            try { if (conn(fqdn(m.name)).getDB('admin').runCommand({ isMaster: 1 }).ismaster) return fqdn(m.name); } catch (e) { /* skip */ }
        }
        return null;
    });
}

ensureReplicaSet(LAYOUT.config);
LAYOUT.shards.forEach(ensureReplicaSet);

const router = waitFor('mongos', () => { const c = conn('mongos.' + NS + '.svc.cluster.local'); c.getDB('admin').runCommand({ ping: 1 }); return c; });
const admin = router.getDB('admin');

// With arbiters the implicit majority default (MongoDB >= 5.0) would break addShard; MongoDB 4.4 defaults to w:1. Setting an
// explicit default makes both behave the same. w:2 = both data members of the shard (an arbiter cannot acknowledge writes).
printjson(admin.adminCommand({ setDefaultRWConcern: 1, defaultWriteConcern: { w: 2, wtimeout: 5000 }, defaultReadConcern: { level: 'local' } }));

const existing = admin.adminCommand({ listShards: 1 }).shards.map((s) => s._id);
for (const s of LAYOUT.shards) {
    if (existing.includes(s.name)) continue;
    const seeds = s.members.filter((m) => !m.arbiter).map((m) => fqdn(m.name) + ':27017').join(',');
    printjson(admin.adminCommand({ addShard: s.name + '/' + seeds, name: s.name }));
}

admin.adminCommand({ enableSharding: LAYOUT.database });
const coll = LAYOUT.database + '.hazards';
if (router.getDB('config').collections.count({ _id: coll }) === 0) {
    // Hash of the deterministic hazard_id: even spread regardless of geographic skew, and _id uniqueness is global.
    printjson(admin.adminCommand({ shardCollection: coll, key: { _id: 'hashed' }, numInitialChunks: 6 }));
}

const appPwd = _getEnv('MONGO_APP_PASSWORD');
if (!router.getDB('admin').getUser('aggregator')) {
    router.getDB('admin').createUser({ user: 'aggregator', pwd: appPwd, roles: [{ role: 'readWrite', db: LAYOUT.database }], writeConcern: { w: 'majority' } });  // user management refuses the w:2 default
    print('created user aggregator');
}

// Shard-local read-only user for per-member probes (placement report, unavailable_units, /audit/location).
for (const s of LAYOUT.shards) {
    const host = primaryHost(s);
    const sdb = conn(host).getDB('admin');
    if (!sdb.getUser('probe')) {
        sdb.createUser({ user: 'probe', pwd: _getEnv('STORE_PROBE_PASSWORD'), roles: [{ role: 'read', db: LAYOUT.database }, { role: 'clusterMonitor', db: 'admin' }], writeConcern: { w: 'majority' } });
        print('created user probe on ' + s.name);
    }
}
print('store bootstrap complete');
`;
writeFileSync(join(here, 'init.js'), init);
console.log('wrote members.yaml, init.js, layout.json');
