#!/usr/bin/env bash
# P2 criteria 6, 7, 8 with k6 (run from outside the cluster, through the NodePorts):
#   7  throughput with 3 aggregator instances >= 2.0x the throughput with 1
#   6  sustained load while the aggregator is scaled 3 -> 5 -> 2 -> 3: error rate outside controlled 429 rejections < 1%
#   8  a rolling update during the load without a single failed request
# Env: RATE (req/s for phases 6 and 8, default 60, well below the capacity measured on 3 VMs sharing one PC: ~100-150 req/s through
# NodePort -> client-api -> aggregator -> mongos -> shards, where all three VMs reach ~95% CPU, half of it kernel/network time),
# SKIP_THROUGHPUT=1 (skip phase 7), VUS (default 1000; the spec asks for >= 10000, which this PC cannot generate: report the number you used), PHASE_S (60),
# SCALE_S (150). The aggregator HPA is deleted during the run and restored on exit. Needs k6 on PATH.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
command -v k6 >/dev/null || { echo "k6 is required (https://k6.io)" >&2; exit 1; }
VUS=${VUS:-1000}; PHASE=${PHASE_S:-60}; SCALE_S=${SCALE_S:-150}; RATE=${RATE:-60}
SECRET=$(envget AUTH_CLIENT_BNPB_OPS_SECRET)
tmp=$(mktemp -d); HPA_SAVED=0
restore() {
  [ "$HPA_SAVED" = 1 ] && kubectl -n "$NS" apply -f "$tmp/hpa.json" >/dev/null 2>&1 && echo ">>> HPA restored"
  kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null 2>&1 || true
  cleanup_pf; rm -rf "$tmp"
}
trap restore EXIT
if kubectl -n "$NS" get hpa aggregator-hpa >/dev/null 2>&1; then
  kubectl -n "$NS" get hpa aggregator-hpa -o json | jq 'del(.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.managedFields,.status)' > "$tmp/hpa.json"
  kubectl -n "$NS" delete hpa aggregator-hpa >/dev/null; HPA_SAVED=1
fi
run_k6() { # run_k6 <name> <duration> [rate]: rate 0 = closed model at $VUS users (saturation), else a fixed arrival rate
  k6 run --quiet -e BASE_URL="$API_URL" -e AUTH_URL="$AUTH_URL" -e CLIENT_SECRET="$SECRET" -e VUS="$VUS" -e DURATION="$2" -e RATE="${3:-0}" \
    --summary-export "$tmp/$1.json" "$(dirname "$0")/../../load-test/p2-scale.js" >"$tmp/$1.log" 2>&1 || true
}
stat() { jq -r "$2" "$tmp/$1.json"; }
settle() { kubectl -n "$NS" rollout status deploy/aggregator --timeout=240s >/dev/null; sleep 10; }

if [ "${SKIP_THROUGHPUT:-0}" = 1 ]; then echo ">>> 7. skipped"; else
echo ">>> 7. successful throughput (HTTP 200/s) at saturation: 1 instance vs 3 instances, $VUS closed-loop VUs, ${PHASE}s each"
kubectl -n "$NS" scale deploy/aggregator --replicas=1 >/dev/null; settle
run_k6 t1 "${PHASE}s"; r1=$(awk -v n="$(stat t1 '.metrics.ok_200.count // 0')" -v d="$PHASE" 'BEGIN{printf "%.1f", n/d}'); f1=$(stat t1 '.metrics.http_req_failed.value // 0')
kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null; settle
run_k6 t3 "${PHASE}s"; r3=$(awk -v n="$(stat t3 '.metrics.ok_200.count // 0')" -v d="$PHASE" 'BEGIN{printf "%.1f", n/d}'); f3=$(stat t3 '.metrics.http_req_failed.value // 0')
ratio=$(awk -v a="$r3" -v b="$r1" 'BEGIN{printf "%.2f", (b>0)?a/b:0}')
echo "     1 instance: $(printf '%.0f' "$r1") req/s (failed $f1); 3 instances: $(printf '%.0f' "$r3") req/s (failed $f3); ratio $ratio"
awk -v r="$ratio" 'BEGIN{exit !(r>=2.0)}' && pass "throughput with 3 instances is ${ratio}x one instance (>= 2.0x)" || fail "throughput ratio is only ${ratio}x (needs >= 2.0x); the bottleneck may be outside the aggregator (client-api in-flight limit, store)"

fi
echo ">>> 6. scale 3 -> 5 -> 2 -> 3 during ${SCALE_S}s at a fixed $RATE req/s"
( sleep $((SCALE_S/5)); kubectl -n "$NS" scale deploy/aggregator --replicas=5 >/dev/null
  sleep $((SCALE_S/4)); kubectl -n "$NS" scale deploy/aggregator --replicas=2 >/dev/null
  sleep $((SCALE_S/4)); kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null ) &
sc=$!
run_k6 scale "${SCALE_S}s" "$RATE"; wait "$sc" || true
fs=$(stat scale '.metrics.http_req_failed.value // 0'); n=$(stat scale '.metrics.http_reqs.count'); rej=$(stat scale '.metrics.controlled_rejected_429.count // 0')
echo "     requests: $n, failed (excluding controlled 429): rate $fs, controlled 429 rejections: $rej"
awk -v f="$fs" 'BEGIN{exit !(f<0.01)}' && pass "error rate outside controlled rejections is $fs (< 0.01) while scaling 3->5->2->3" || fail "error rate $fs while scaling (needs < 0.01)"
settle
"$(dirname "$0")/p2-single-fetch.sh" >"$tmp/sf.log" 2>&1 && pass "criterion 2 still holds after the scaling (no duplicates, one caller)" || { fail "criterion 2 broken after the scaling"; tail -5 "$tmp/sf.log"; }

echo ">>> 8. rolling update during ${PHASE}s at a fixed $RATE req/s"
( sleep 15; kubectl -n "$NS" set env deploy/aggregator ROLLOUT_VERSION="v$(date +%s)" >/dev/null ) &
ru=$!
run_k6 roll "${PHASE}s" "$RATE"; wait "$ru" || true
settle
fr=$(stat roll '.metrics.http_req_failed.value // 0'); nr=$(stat roll '.metrics.http_reqs.count')
echo "     requests: $nr, failed rate: $fr"
awk -v f="$fr" 'BEGIN{exit !(f==0)}' && pass "rolling update with zero failed requests" || fail "rolling update caused failed requests (rate $fr)"
echo "     highest sustained VU count used: $VUS (the spec asks for >= 10000)"
finish
