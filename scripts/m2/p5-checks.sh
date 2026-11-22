#!/usr/bin/env bash
# P5 criteria 3 and 4 with the fake sensor (k8s/test/sensor-fake.yaml, never part of the demo): while Sensor Pantai misbehaves
# (slow, blackhole, HTTP 503, malformed, stale, frozen) the other sources keep M1 latency (p95 < 300 ms), the requests sent to the
# sensor do not spike, a client request that depends on the sensor is answered fast, and the system uses the sensor again by itself
# once it is healthy. The aggregator is pointed at the fake sensor for the test and restored on exit.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MODES=${MODES:-"slow blackhole status malformed stale frozen"}; WINDOW=${WINDOW_S:-40}
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
fake_mode() { kubectl -n "$NS" exec deploy/sensor-fake -- node -e "fetch('http://127.0.0.1:8080/admin/mode',{method:'POST',headers:{authorization:'Bearer '+process.env.PANTAI_AUTH_TOKEN,'content-type':'application/json'},body:JSON.stringify($1)}).then(r=>r.text()).then(t=>console.log(t))" 2>&1 | tail -1; }
metric_sum() { # metric_sum <regex over metric lines>: summed over every aggregator pod
  local p t=0 v
  for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}'); do
    v=$(kubectl -n "$NS" exec "$p" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null | awk -v re="$1" '$0 ~ re {s+=$NF} END{print s+0}')
    t=$(awk -v a="$t" -v b="$v" 'BEGIN{print a+b}')
  done; echo "$t"
}
p95() { LC_ALL=C sort -n | awk '{a[NR]=$1} END{if(NR==0)print 0; else print a[int(NR*0.95+0.999)]}'; }
timed_events() { # timed_events <query> <n> -> ms of each request, status in $tmp (last)
  local tok i; tok=$(mint field-team AUTH_CLIENT_FIELD_TEAM_SECRET)
  for i in $(seq 1 "$2"); do curl -s -m 5 -o /dev/null -w '%{http_code} %{time_total}\n' -H "Authorization: Bearer $tok" "$API_URL/events?$1&limit=20"; sleep 0.5; done
}
ms() { awk '{printf "%d\n", $2*1000}'; }

echo ">>> baseline (fake sensor in normal mode), ${WINDOW}s"
fake_mode '{"mode":"normal"}' >/dev/null
r0=$(metric_sum '^coastal_sensor_requests_total'); sleep "$WINDOW"; r1=$(metric_sum '^coastal_sensor_requests_total')
base=$(awk -v a="$r0" -v b="$r1" 'BEGIN{print b-a}'); echo "     sensor requests in ${WINDOW}s: $base"
[ "$(awk -v b="$base" 'BEGIN{print (b>0)}')" = 1 ] && pass "the aggregator polls the (fake) sensor in normal mode ($base requests)" || fail "no sensor requests in normal mode: the coastal poller is not running"
b95=$(timed_events 'hazard_type=SEISMIC' 20 | ms | p95); echo "     SEISMIC p95: ${b95} ms"

for mode in $MODES; do
  echo ">>> mode: $mode"
  case $mode in
    slow) body='{"mode":"slow","delay_ms":2500}';; status) body='{"mode":"status","status":503}';; *) body="{\"mode\":\"$mode\"}";;
  esac
  fake_mode "$body" >/dev/null; sleep 5
  r0=$(metric_sum '^coastal_sensor_requests_total'); t0=$(date +%s)
  other=$(timed_events 'hazard_type=SEISMIC' $(( WINDOW / 2 )) | tee /tmp/p5-other.$$ | ms | p95)
  coast=$(timed_events 'hazard_type=COASTAL' 6 | tee /tmp/p5-coast.$$)
  rest=$(( WINDOW - ($(date +%s) - t0) )); [ "$rest" -gt 0 ] && sleep "$rest"
  r1=$(metric_sum '^coastal_sensor_requests_total'); sent=$(awk -v a="$r0" -v b="$r1" 'BEGIN{print b-a}')
  bad=$(awk '$1!="200"' /tmp/p5-other.$$ | wc -l | tr -d ' '); cbad=$(awk '$1!="200"' /tmp/p5-coast.$$ | wc -l | tr -d ' '); cmax=$(printf '%s\n' "$coast" | ms | LC_ALL=C sort -n | tail -1)
  rm -f /tmp/p5-other.$$ /tmp/p5-coast.$$
  [ "$other" -lt 300 ] && [ "$bad" = 0 ] && pass "$mode: other sources keep M1 latency (SEISMIC p95 ${other} ms < 300 ms, 0 failures)" || fail "$mode: SEISMIC p95 ${other} ms, $bad failed request(s)"
  [ "$cbad" = 0 ] && [ "$cmax" -lt 1500 ] && pass "$mode: a request depending on the sensor was answered fast (max ${cmax} ms, status 200)" || fail "$mode: sensor-dependent request slow or failed (max ${cmax} ms, $cbad failed)"
  limit=$(awk -v b="$base" 'BEGIN{printf "%d", b*1.5+3}')
  [ "$(awk -v s="$sent" -v l="$limit" 'BEGIN{print (s<=l)}')" = 1 ] && pass "$mode: requests to the sensor did not spike ($sent in ${WINDOW}s, baseline $base, limit $limit)" || fail "$mode: $sent requests to the sick sensor in ${WINDOW}s (baseline $base)"
  fake_mode '{"mode":"normal"}' >/dev/null
  ok0=$(metric_sum '^coastal_poll_total[{]outcome="ok"[}]'); rec=""
  for i in $(seq 1 90); do sleep 1; okn=$(metric_sum '^coastal_poll_total[{]outcome="ok"[}]'); [ "$(awk -v a="$ok0" -v b="$okn" 'BEGIN{print (b>a)}')" = 1 ] && { rec=$i; break; }; done
  [ -n "$rec" ] && pass "$mode: the system used the sensor again by itself after ~${rec}s, no intervention" || fail "$mode: no successful poll within 90 s after the sensor recovered"
done
finish
