#!/usr/bin/env bash
# Bonus "capacity that follows the load" (HPA): replica counts of client-api and the aggregator while the load rises and then falls.
#   [PEAK=60 LOW=5 UP_S=90 HOLD_S=90 DOWN_S=60 SETTLE_MAX_S=420]  scripts/m2/hpa-ramp.sh
# 1. waits until both Deployments are at their HPA minimum, 2. runs load-test/hpa-ramp.js (k6) while a sampler prints, every 10 s, the load phase, the replicas
# (ready/desired) and the CPU utilisation the HPA sees, 3. after the load has stopped, keeps sampling until the replicas are back at the minimum (or SETTLE_MAX_S).
# PASS needs: client-api AND/OR the aggregator scaled UP above their minimum during the ramp, and BOTH back at their minimum after it (scale down).
# HPA settings in k8s/overlays/demo/hpa.yaml: target 60% CPU of the request, up 2 pods / 15 s, down 1 pod / 30 s after a 45 s stabilisation window.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
export PATH="$PATH:$HOME/.local/bin"; command -v k6 >/dev/null || { echo "k6 is required" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PEAK=${PEAK:-60}; LOW=${LOW:-5}; UP_S=${UP_S:-90}; HOLD_S=${HOLD_S:-90}; DOWN_S=${DOWN_S:-60}; SETTLE_MAX=${SETTLE_MAX_S:-420}
tmp=$(mktemp -d); trap 'kill ${K6PID:-0} 2>/dev/null || true; rm -rf "$tmp"' EXIT
hpa() { # hpa <name> -> "min max ready desired cpu%"
  kubectl -n "$NS" get hpa "$1-hpa" -o json | jq -r '[.spec.minReplicas, .spec.maxReplicas, (.status.currentReplicas // 0), (.status.desiredReplicas // 0), ((.status.currentMetrics[0].resource.current.averageUtilization) // -1)] | @tsv'
}
read -r cmin cmax _ _ _ <<<"$(hpa client-api)"; read -r amin amax _ _ _ <<<"$(hpa aggregator)"
echo ">>> HPA: client-api min $cmin max $cmax, aggregator min $amin max $amax (target 60% CPU of the request)"
echo ">>> waiting until both are at their minimum (up to 8 min)"
for _ in $(seq 1 48); do read -r _ _ cr _ _ <<<"$(hpa client-api)"; read -r _ _ ar _ _ <<<"$(hpa aggregator)"; [ "$cr" = "$cmin" ] && [ "$ar" = "$amin" ] && break; sleep 10; done
[ "$cr" = "$cmin" ] && [ "$ar" = "$amin" ] || { echo "STOP: replicas did not return to the minimum before the test (client-api $cr, aggregator $ar)" >&2; exit 1; }
echo ">>> both at their minimum; load ramp: 0 -> $LOW -> $PEAK users in ${UP_S}s, hold ${HOLD_S}s, back to $LOW in ${DOWN_S}s, then 0"
printf '%-9s %-12s | %-34s | %-34s\n' "time" "phase" "client-api ready/desired cpu%" "aggregator ready/desired cpu%"
k6 run --quiet -e BASE_URL="$API_URL" -e AUTH_URL="$AUTH_URL" -e CLIENT_SECRET="$(envget AUTH_CLIENT_BNPB_OPS_SECRET)" -e PEAK="$PEAK" -e LOW="$LOW" -e UP_S="$UP_S" -e HOLD_S="$HOLD_S" -e DOWN_S="$DOWN_S" --summary-export "$tmp/k6.json" "$ROOT/load-test/hpa-ramp.js" >"$tmp/k6.log" 2>&1 &
K6PID=$!; T0=$SECONDS; LOAD_S=$((20 + UP_S + HOLD_S + DOWN_S + 20)); maxc=$cmin; maxa=$amin; : > "$tmp/samples"
sample() { local phase=$1 c a; read -r _ _ cr cd cc <<<"$(hpa client-api)"; read -r _ _ ar ad ac <<<"$(hpa aggregator)"
  printf '%-9s %-12s | %-34s | %-34s\n' "+$((SECONDS - T0))s" "$phase" "$cr/$cd  ${cc}%" "$ar/$ad  ${ac}%"; echo "$cr $ar" >> "$tmp/samples"; }
while kill -0 "$K6PID" 2>/dev/null; do
  e=$((SECONDS - T0)); if [ $e -lt 20 ]; then ph=warm-up; elif [ $e -lt $((20 + UP_S)) ]; then ph=ramp-up; elif [ $e -lt $((20 + UP_S + HOLD_S)) ]; then ph=hold; elif [ $e -lt $((20 + UP_S + HOLD_S + DOWN_S)) ]; then ph=ramp-down; else ph=stopping; fi
  sample "$ph"; sleep 10
done
wait "$K6PID" 2>/dev/null || true; echo ">>> load stopped at +$((SECONDS - T0))s; sampling until both are back at their minimum"
settled=""; for _ in $(seq 1 $((SETTLE_MAX / 10))); do sample "no-load"; read -r cr ar < <(tail -1 "$tmp/samples"); [ "$cr" = "$cmin" ] && [ "$ar" = "$amin" ] && { settled=$((SECONDS - T0)); break; }; sleep 10; done
maxc=$(awk '{if($1>m)m=$1} END{print m+0}' "$tmp/samples"); maxa=$(awk '{if($2>m)m=$2} END{print m+0}' "$tmp/samples")
echo "k6: $(jq -r '"requests \(.metrics.http_reqs.count), failed \(.metrics.http_req_failed.value * 100 | floor)%, p95 \(.metrics.http_req_duration["p(95)"] | floor) ms"' "$tmp/k6.json" 2>/dev/null)"
echo "client-api replicas: min $cmin -> peak $maxc -> back to $cr; aggregator replicas: min $amin -> peak $maxa -> back to $ar"
[ "$maxc" -gt "$cmin" ] || [ "$maxa" -gt "$amin" ] && pass "scaled UP with the load (client-api peak $maxc of max $cmax, aggregator peak $maxa of max $amax)" || fail "no scale up: client-api stayed at $cmin and the aggregator at $amin"
[ -n "$settled" ] && pass "scaled DOWN after the load stopped: both back at their minimum $((settled - LOAD_S)) s after the load ended" || fail "replicas did not return to the minimum within ${SETTLE_MAX}s of the end of the load (client-api $cr, aggregator $ar)"
finish
