#!/usr/bin/env bash
# PoC gate 1 for MongoDB: one data-bearing mongod under the OFFICIAL storage limit (1Gi), WiredTiger cache 0.25 GB,
# loaded with HazardEvent-shaped documents plus the query indexes. Reports peak memory and OOM status.
# Usage: poc/storage/mongo-mem.sh [documents=300000]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
N=${1:-300000}; C=poc-mongo-mem
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --name $C --memory 1g --memory-swap 1g docker.io/library/mongo:7 --wiredTigerCacheSizeGB 0.25 --oplogSize 256 >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
until docker exec $C mongosh --quiet --eval 'db.adminCommand({ping:1}).ok' >/dev/null 2>&1; do sleep 1; done
echo ">>> loading $N documents while sampling memory"
( docker exec -i $C mongosh --quiet --eval "
  const db = db.getSiblingDB('bnpb_canonical_store'); const c = db.hazards;
  c.createIndex({occurred_at:-1, hazard_id:1}); c.createIndex({ingested_at:1, hazard_id:1}); c.createIndex({source:1, source_ref_id:1});
  const types=['SEISMIC','VOLCANIC','WILDFIRE','COASTAL']; let batch=[];
  for (let i=0;i<$N;i++){ batch.push({_id:'hz-'+i.toString(16).padStart(16,'0'), hazard_id:'hz-'+i, source:'BMKG', source_ref_id:'EV-'+i,
    hazard_type:types[i%4], severity:'WASPADA', area_name:'Area '+(i%34), latitude:-2+Math.random(), longitude:110+Math.random(),
    occurred_at:new Date(Date.now()-i*1000).toISOString(), ingested_at:new Date().toISOString(), attributes:{magnitude:5.1, depth_km:10, note:'x'.repeat(120)}});
    if (batch.length===5000){ c.insertMany(batch,{ordered:false}); batch=[]; } }
  if (batch.length) c.insertMany(batch); print('docs', c.countDocuments());" ) &
LOAD=$!
peak=$(sample_peak $C 60)
wait $LOAD || true
peak2=$(sample_peak $C 10)
[ "$peak2" -gt "$peak" ] && peak=$peak2
echo "peak memory: ${peak} MiB of 1024 MiB limit; OOMKilled=$(oom_killed $C)"
[ "$(oom_killed $C)" = false ] && [ "$peak" -lt 900 ] && echo "GATE 1 (mongod): PASS" || { echo "GATE 1 (mongod): FAIL" >&2; exit 1; }
