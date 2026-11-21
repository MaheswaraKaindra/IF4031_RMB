#!/usr/bin/env bash
# P5 criterion 3 with the inherited M1 workload: while Sensor Pantai is in a fault mode, run load-test/events.js (50 virtual users, 25 SEISMIC-only and 25 VOLCANIC,
# 60 s, M1 threshold: SEISMIC p95 < 300 ms, failed requests < 1%) against the cluster and report the result per mode. Baseline (normal sensor) first.
#   MODES="normal slow blackhole" [DURATION=60s VUS_EACH=25]  scripts/k8s/p5-m1-load.sh
# Needs k6 and AUTH_CLIENT_BNPB_OPS_SECRET in .env. The aggregator is pointed at the fake sensor for the test and restored on exit.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODES=${MODES:-"normal slow blackhole"}; DURATION=${DURATION:-60s}; VUS_EACH=${VUS_EACH:-25}
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

for mode in $MODES; do
  echo ">>> mode: $mode"
  case $mode in
    normal) b='{"mode":"normal"}';; slow) b='{"mode":"slow","delay_ms":2500}';; status) b='{"mode":"status","status":503}';; *) b="{\"mode\":\"$mode\"}";;
  esac
  fake_mode "$b" >/dev/null; sleep 8
  out=$(k6 run --quiet -e CLIENT_SECRET="$(envget AUTH_CLIENT_BNPB_OPS_SECRET)" -e BASE_URL="$API_URL" -e AUTH_URL="$AUTH_URL" -e DURATION="$DURATION" -e VUS_EACH="$VUS_EACH" --summary-export="/tmp/m1-$mode.json" "$ROOT/load-test/events.js" 2>&1 || true)
  echo "$out" | grep -E "http_req_duration|http_req_failed|rejected_429|iterations" | cut -c1-170
  p=$(jq '.metrics["http_req_duration{scenario:bmkg_only,endpoint:events}"]["p(95)"]' "/tmp/m1-$mode.json"); f=$(jq '.metrics.http_req_failed.value' "/tmp/m1-$mode.json")
  [ "$(awk -v p="$p" -v f="$f" 'BEGIN{print (p<300 && f<0.01)}')" = 1 ] && pass "$mode: M1 workload SEISMIC p95 ${p} ms (< 300 ms), failed ${f}" || fail "$mode: M1 workload SEISMIC p95 ${p} ms, failed ${f}"
done
fake_mode '{"mode":"normal"}' >/dev/null
finish
