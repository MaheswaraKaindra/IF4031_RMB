#!/usr/bin/env bash
# PoC gate 1 for CockroachDB: one node under the same 1Gi limit. This is a TIME-BOXED smoke test: on 3 nodes
# CockroachDB is eliminated by topology (docs/decisions/ADR-0001-storage.md), so this only documents memory behaviour
# for the decision record and for the case where the demo grows to >= 4 nodes.
# Usage: poc/storage/cockroach-mem.sh [rows=300000]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
N=${1:-300000}; C=poc-crdb-mem
docker rm -f $C >/dev/null 2>&1 || true
docker run -d --name $C --memory 1g --memory-swap 1g docker.io/cockroachdb/cockroach:v24.3.0 start-single-node --insecure \
  --cache=128MiB --max-sql-memory=128MiB >/dev/null
trap 'docker rm -f $C >/dev/null 2>&1 || true' EXIT
until docker exec $C ./cockroach sql --insecure -e 'select 1' >/dev/null 2>&1; do sleep 1; done
echo ">>> loading $N rows while sampling memory"
( docker exec -i $C ./cockroach sql --insecure <<SQL
CREATE DATABASE IF NOT EXISTS bnpb;
CREATE TABLE bnpb.hazards (id STRING PRIMARY KEY, source STRING, source_ref_id STRING, hazard_type STRING, severity STRING,
  area_name STRING, occurred_at TIMESTAMPTZ, ingested_at TIMESTAMPTZ, attributes JSONB,
  INDEX (occurred_at DESC, id), INDEX (ingested_at, id));
INSERT INTO bnpb.hazards SELECT 'hz-' || g::STRING, 'BMKG', 'EV-' || g::STRING, 'SEISMIC', 'WASPADA', 'Area ' || (g % 34)::STRING,
  now() - (g || ' seconds')::INTERVAL, now(), jsonb_build_object('magnitude', 5.1, 'note', repeat('x', 120)) FROM generate_series(1, $N) g;
SELECT count(*) FROM bnpb.hazards;
SQL
) &
LOAD=$!
peak=$(sample_peak $C 70)
wait $LOAD || true
peak2=$(sample_peak $C 10)
[ "$peak2" -gt "$peak" ] && peak=$peak2
echo "peak memory: ${peak} MiB of 1024 MiB limit; OOMKilled=$(oom_killed $C)"
[ "$(oom_killed $C)" = false ] && [ "$peak" -lt 900 ] && echo "GATE 1 (cockroach): PASS" || { echo "GATE 1 (cockroach): FAIL" >&2; exit 1; }
