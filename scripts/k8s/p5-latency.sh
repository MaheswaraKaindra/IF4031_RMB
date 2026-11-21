#!/usr/bin/env bash
# P5 criterion 1, measured end to end: critical observations are emitted into the FAKE sensor at a steady rate (so the emission time
# is known), a failure is injected while they flow, and the latency from emission to the receiver's acknowledgement is computed.
# Unlike `coastal-tool synthetic` this includes the poll interval, the sensor-to-aggregator hop, the publish and the consumer.
#   SCENARIO=baseline|kill-leader|node-loss  [N=600 RATE=5 DEADLINE_MS=5000 FAIL_AT_S=40]  scripts/k8s/p5-latency.sh
#   kill-leader  the Node process of the coastal leader is SIGKILLed from its node over SSH (no lease release; the container restarts)
#   node-loss    the node of the coastal leader is powered off (needs VM_STOP_CMD / VM_START_CMD, see assert-lib.sh)
# PASS needs: 0 emitted alerts lost (all in the ledger and acknowledged) and p95 <= the deadline. The aggregator is pointed at the fake sensor for
# the run and restored on exit. Needs PANTAI_AUTH_TOKEN and MONGO_APP_PASSWORD in .env (read here, never printed).
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCENARIO=${SCENARIO:-baseline}; N=${N:-600}; RATE=${RATE:-5}; DEADLINE=${DEADLINE_MS:-5000}; FAIL_AT=${FAIL_AT_S:-40}
tmp=$(mktemp -d); PFS=(); STOPPED_NODE=""
ORIG_URL=$(kubectl -n "$NS" get deploy aggregator -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="SENSOR_PANTAI_URL")]}{.value}{end}')
[ -n "$ORIG_URL" ] || ORIG_URL=http://sensor-pantai:8080
IMG=$(kubectl -n "$NS" get deploy aggregator -o jsonpath='{.spec.template.spec.containers[0].image}')
restore() {
  for p in "${PFS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  [ -n "$STOPPED_NODE" ] && { echo ">>> starting $STOPPED_NODE again"; vm_do start "$STOPPED_NODE" || true; node_ready_wait "$STOPPED_NODE" 300 || true; }
  echo ">>> restoring the aggregator's sensor URL ($ORIG_URL) and removing the fake sensor"
  kubectl -n "$NS" set env deploy/aggregator SENSOR_PANTAI_URL="$ORIG_URL" >/dev/null 2>&1 || true
  kubectl -n "$NS" delete deploy/sensor-fake svc/sensor-fake networkpolicy/allow-sensor-fake-from-namespace --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap restore EXIT

sed "s#bnpb/aggregator:dev#$IMG#" "$ROOT/k8s/test/sensor-fake.yaml" | kubectl -n "$NS" apply -f - >/dev/null
kubectl -n "$NS" rollout status deploy/sensor-fake --timeout=180s >/dev/null
kubectl -n "$NS" set env deploy/aggregator SENSOR_PANTAI_URL=http://sensor-fake:8080 >/dev/null
kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null
wait_for 120 all_ready aggregator || { echo "aggregator not ready" >&2; exit 1; }
sleep 30 # the coastal leader needs a moment to start polling the fake sensor

envfile() { grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2-; }
export PANTAI_AUTH_TOKEN; PANTAI_AUTH_TOKEN=$(envfile PANTAI_AUTH_TOKEN)
export MONGO_URI="mongodb://aggregator:$(envfile MONGO_APP_PASSWORD)@127.0.0.1:27018/?authSource=admin"
export FAKE_SENSOR_URL=http://127.0.0.1:18084
kubectl -n "$NS" port-forward svc/sensor-fake 18084:8080 >/dev/null 2>&1 & PFS+=($!)
kubectl -n "$NS" port-forward svc/mongos 27018:27017 >/dev/null 2>&1 & PFS+=($!)
for _ in $(seq 1 30); do curl -s -m 1 -o /dev/null "$FAKE_SENSOR_URL/health" && break; sleep 1; done
TOOL=(node --import tsx "$ROOT/aggregator/src/tools/coastal-tool.ts")

leader=$(lease_holder aggregator-coastal); lnode=$(pod_node "$leader"); echo "coastal leader: $leader on $lnode; scenario: $SCENARIO"
( cd "$ROOT/aggregator" && "${TOOL[@]}" emit --n "$N" --rate "$RATE" --out "$tmp/emitted.json" > "$tmp/emit.out" 2>&1 ) & EMIT=$!
sleep "$FAIL_AT"
case $SCENARIO in
  baseline) echo ">>> no failure" ;;
  kill-leader)
    echo ">>> killing the coastal leader process ($leader) with SIGKILL from its node (no lease release, no cleanup)"
    crash_pod_process "$leader" "$lnode" >/dev/null 2>&1 || true ;;
  node-loss)
    echo ">>> powering off $lnode (leader's node)"
    use_survivor "$lnode"; vm_do stop "$lnode"; STOPPED_NODE=$lnode ;;
  *) echo "unknown SCENARIO $SCENARIO" >&2; exit 2 ;;
esac
wait "$EMIT" || true; cat "$tmp/emit.out"
echo ">>> waiting 40 s for the last alerts to be delivered"; sleep 40
newl=$(lease_holder aggregator-coastal); echo "coastal leader now: $newl (leadership changes seen: $([ "$newl" = "$leader" ] && echo no || echo yes))"
cd "$ROOT/aggregator"
"${TOOL[@]}" latency --emitted "$tmp/emitted.json" --deadline "$DEADLINE" > "$tmp/latency.json" || true
cat "$tmp/latency.json"
lost=$(jq '.not_in_ledger + .not_delivered' "$tmp/latency.json"); p95=$(jq '.p95_ms' "$tmp/latency.json"); miss=$(jq '.deadline_misses' "$tmp/latency.json")
[ "$lost" = 0 ] && pass "$SCENARIO: 0 critical alerts lost ($(jq '.delivered' "$tmp/latency.json") of $(jq '.emitted' "$tmp/latency.json") delivered)" || fail "$SCENARIO: $lost critical alert(s) lost or never delivered"
[ "$p95" != null ] && [ "$p95" -le "$DEADLINE" ] && pass "$SCENARIO: p95 from emission = ${p95} ms (deadline ${DEADLINE} ms), $miss alert(s) over the deadline" || fail "$SCENARIO: p95 from emission = ${p95} ms exceeds the ${DEADLINE} ms deadline ($miss alert(s) over it)"
finish
