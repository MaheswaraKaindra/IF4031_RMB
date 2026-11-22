#!/usr/bin/env bash
# P5 criterion 2: data that violates the base sensor contract is NOT stored as a HazardEvent but set aside with its reason. The fake sensor is put into its
# normal mode and ITEMS THAT BREAK THE CONTRACT are injected into its observation log (missing field, wrong type, unknown station, impossible value, one flagged critical); afterwards the quarantined sensor messages are listed as BNPB Internal Ops (GET /unprocessed) with source, reason and time, and the number of
# SENSOR_PANTAI HazardEvents is compared before and after to show that nothing from the bad responses entered the store.
#   scripts/m2/p5-quarantine.sh      [WAIT_S=30]
set -euo pipefail
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WAIT=${WAIT_S:-30}
ORIG_URL=$(kubectl -n "$NS" get deploy aggregator -o jsonpath='{range .spec.template.spec.containers[0].env[?(@.name=="SENSOR_PANTAI_URL")]}{.value}{end}')
[ -n "$ORIG_URL" ] || ORIG_URL=http://sensor-pantai:8080
IMG=$(kubectl -n "$NS" get deploy aggregator -o jsonpath='{.spec.template.spec.containers[0].image}')
restore() {
  echo ">>> restoring the aggregator's sensor URL ($ORIG_URL) and removing the fake sensor"
  kubectl -n "$NS" set env deploy/aggregator SENSOR_PANTAI_URL="$ORIG_URL" >/dev/null 2>&1 || true
  kubectl -n "$NS" delete deploy/sensor-fake svc/sensor-fake networkpolicy/allow-sensor-fake-from-namespace --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null 2>&1 || true
  cleanup_pf
}
trap restore EXIT

sed "s#bnpb/aggregator:dev#$IMG#" "$ROOT/k8s/test/sensor-fake.yaml" | kubectl -n "$NS" apply -f - >/dev/null
kubectl -n "$NS" rollout status deploy/sensor-fake --timeout=180s >/dev/null
kubectl -n "$NS" set env deploy/aggregator SENSOR_PANTAI_URL=http://sensor-fake:8080 >/dev/null
kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null; sleep 40
sed "s#bnpb/aggregator:dev#$IMG#" "$ROOT/k8s/test/sensor-fake.yaml" | kubectl -n "$NS" apply -f - >/dev/null
kubectl -n "$NS" rollout status deploy/sensor-fake --timeout=180s >/dev/null
kubectl -n "$NS" set env deploy/aggregator SENSOR_PANTAI_URL=http://sensor-fake:8080 >/dev/null
kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null; sleep 40
fake_mode() { kubectl -n "$NS" exec deploy/sensor-fake -- node -e "fetch('http://127.0.0.1:8080/admin/mode',{method:'POST',headers:{authorization:'Bearer '+process.env.PANTAI_AUTH_TOKEN,'content-type':'application/json'},body:JSON.stringify($1)}).then(r=>r.text()).then(t=>console.log(t))" 2>&1 | tail -1; }


fake_post() { # fake_post <path> <json>
  kubectl -n "$NS" exec deploy/sensor-fake -- node -e "fetch('http://127.0.0.1:8080$1',{method:'POST',headers:{authorization:'Bearer '+process.env.PANTAI_AUTH_TOKEN,'content-type':'application/json'},body:JSON.stringify($2)}).then(r=>r.text()).then(t=>console.log(t))" 2>&1 | tail -1; }
listq() { curl -s -m 10 "$API_URL/unprocessed?limit=1000" -H "Authorization: Bearer $(mint bnpb-ops AUTH_CLIENT_BNPB_OPS_SECRET)" | jq -c '[.items[] | select(.source=="SENSOR_PANTAI")]'; }
count_events() { audit "/internal/audit/checksum?source=SENSOR_PANTAI" | jq -r '.count'; }
fake_mode '{"mode":"normal"}' >/dev/null; sleep 10
q0=$(listq | jq length); e0=$(count_events); echo "before: $q0 quarantined sensor messages, $e0 SENSOR_PANTAI events"
now=$(date -u +%FT%TZ); run=$(date +%s)
fake_post /admin/enqueue "{\"items\":[
 {\"observation_id\":\"bad-$run-1\",\"station_id\":\"stn-padang-01\",\"sea_level_anomaly_m\":0.1,\"wave_height_m\":1.2,\"quality\":\"ok\"},
 {\"observation_id\":\"bad-$run-2\",\"station_id\":\"stn-padang-01\",\"observed_at\":\"$now\",\"sea_level_anomaly_m\":\"high\",\"wave_height_m\":1.2,\"quality\":\"ok\"},
 {\"observation_id\":\"bad-$run-3\",\"station_id\":\"NO-SUCH-STATION\",\"observed_at\":\"$now\",\"sea_level_anomaly_m\":0.1,\"wave_height_m\":1.2,\"quality\":\"ok\"},
 {\"observation_id\":\"bad-$run-4\",\"station_id\":\"stn-padang-01\",\"observed_at\":\"not-a-time\",\"sea_level_anomaly_m\":0.1,\"wave_height_m\":1.2,\"quality\":\"ok\"},
 {\"observation_id\":\"bad-$run-5\",\"station_id\":\"stn-padang-01\",\"observed_at\":\"$now\",\"sea_level_anomaly_m\":0.1,\"wave_height_m\":-5,\"quality\":\"ok\",\"critical\":true}]}" >/dev/null
echo ">>> 5 contract-breaking items injected, waiting ${WAIT}s"; sleep "$WAIT"
q=$(listq); echo "$q" | jq -r '.[] | "  \(.source_ref_id // "no id")  reason: \(.reason[0:120])  status: \(.status)"' | head -10
[ "$(echo "$q" | jq length)" -gt "$q0" ] && pass "contract-breaking items were set aside with their reason ($(echo "$q" | jq length) listed, was $q0)" || fail "nothing was quarantined"
e1=$(count_events); echo "SENSOR_PANTAI events: before $e0, after $e1 (valid items keep arriving; none of the bad ids may be among them)"
cursor=""; : > /tmp/q-ids.$$; while :; do b=$(audit "/internal/audit/events?source=SENSOR_PANTAI&limit=1000${cursor:+&cursor=$cursor}"); jq -r '.items[].source_ref_id' <<<"$b" >> /tmp/q-ids.$$; cursor=$(jq -r '.next_cursor // empty' <<<"$b"); [ -z "$cursor" ] && break; done
n=$(grep -c "^bad-$run-" /tmp/q-ids.$$ || true); rm -f /tmp/q-ids.$$
[ "$n" = 0 ] && pass "none of the 5 bad items was stored as a HazardEvent" || fail "$n bad item(s) were stored as HazardEvent"
fake_mode '{"mode":"normal"}' >/dev/null
finish
