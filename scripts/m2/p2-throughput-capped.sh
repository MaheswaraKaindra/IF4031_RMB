#!/usr/bin/env bash
# P2 criterion 7 under an ARTIFICIAL CPU limit: successful throughput with 1 vs 3 aggregator instances, each pod capped at CPU_CAP (default 250m).
# Without the cap the three VMs share one PC's CPU, the aggregator is not the bottleneck and the ratio is about 0.9x (see docs/m2/evidence/pc-run-phase2.md).
# With the cap a single instance is compute-bound, so the aggregator tier itself is measured. The cap and the failure rates MUST be stated next to the result.
#   [VUS=40 PHASE_S=45 CPU_CAP=250m]  scripts/m2/p2-throughput-capped.sh
# The aggregator HPA is removed and the cap is set for the test; both are restored on exit. Needs k6 on PATH.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
command -v k6 >/dev/null || { echo "k6 is required" >&2; exit 1; }
VUS=${VUS:-40}; PHASE=${PHASE_S:-45}; CAP=${CPU_CAP:-250m}; SECRET=$(envget AUTH_CLIENT_BNPB_OPS_SECRET)
tmp=$(mktemp -d); HPA_SAVED=0; CAPPED=0
restore() {
  [ "$CAPPED" = 1 ] && kubectl -n "$NS" patch deploy aggregator --type=json -p '[{"op":"remove","path":"/spec/template/spec/containers/0/resources/limits/cpu"}]' >/dev/null 2>&1 && echo ">>> CPU cap removed"
  [ "$HPA_SAVED" = 1 ] && kubectl -n "$NS" apply -f "$tmp/hpa.json" >/dev/null 2>&1 && echo ">>> HPA restored"
  kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null 2>&1 || true
  kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap restore EXIT
if kubectl -n "$NS" get hpa aggregator-hpa >/dev/null 2>&1; then
  kubectl -n "$NS" get hpa aggregator-hpa -o json | jq 'del(.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.managedFields,.status)' > "$tmp/hpa.json"
  kubectl -n "$NS" delete hpa aggregator-hpa >/dev/null; HPA_SAVED=1
fi
echo ">>> ARTIFICIAL: every aggregator pod is limited to $CAP CPU for this test"
kubectl -n "$NS" patch deploy aggregator --type=json -p "[{\"op\":\"add\",\"path\":\"/spec/template/spec/containers/0/resources/limits/cpu\",\"value\":\"$CAP\"}]" >/dev/null; CAPPED=1
measure() { # measure <replicas>
  kubectl -n "$NS" scale deploy/aggregator --replicas="$1" >/dev/null; kubectl -n "$NS" rollout status deploy/aggregator --timeout=300s >/dev/null; sleep 20
  k6 run --quiet -e BASE_URL="$API_URL" -e AUTH_URL="$AUTH_URL" -e CLIENT_SECRET="$SECRET" -e VUS="$VUS" -e DURATION="${PHASE}s" -e RATE=0 --summary-export "$tmp/r$1.json" "$(dirname "$0")/../../load-test/p2-scale.js" >"$tmp/r$1.log" 2>&1 || true
  RATE_OK=$(jq -r --argjson d "$PHASE" '((.metrics.ok_200.count // 0) / $d * 10 | floor) / 10' "$tmp/r$1.json"); FAILED=$(jq -r '.metrics.http_req_failed.value // 1' "$tmp/r$1.json")
  P95=$(jq -r '.metrics.http_req_duration["p(95)"] // 0 | floor' "$tmp/r$1.json")
  echo "     $1 instance(s): $RATE_OK successful req/s, failed requests $(awk -v f="$FAILED" 'BEGIN{printf "%.1f%%", f*100}'), p95 ${P95} ms"
}
echo ">>> $VUS closed-loop virtual users, ${PHASE}s per phase"
measure 1; r1=$RATE_OK; f1=$FAILED
measure 3; r3=$RATE_OK; f3=$FAILED
ratio=$(awk -v a="$r3" -v b="$r1" 'BEGIN{printf "%.2f", (b>0)?a/b:0}')
echo "     ratio 3 instances / 1 instance = ${ratio}x (failed: $(awk -v f="$f1" 'BEGIN{printf "%.0f%%", f*100}') with 1, $(awk -v f="$f3" 'BEGIN{printf "%.0f%%", f*100}') with 3)"
awk -v r="$ratio" 'BEGIN{exit !(r>=2.0)}' && pass "with a CPU limit of $CAP per pod, 3 instances give ${ratio}x the successful throughput of 1 (>= 2.0x)" || fail "ratio ${ratio}x (needs >= 2.0x)"
finish
