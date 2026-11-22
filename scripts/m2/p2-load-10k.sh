#!/usr/bin/env bash
# P2 criteria 6 and 8 with 10,000 virtual users (load-test/vu-sim.mjs, a light asynchronous generator because k6 cannot hold 10,000 VUs in this PC's memory):
# the users start spread over one think time (THINK_S), so all of them are active after THINK_S seconds; from then on the aggregator is scaled 3 -> 5 -> 2,
# rolled to a new version, and scaled back to 3, while the load continues. PASS needs: error rate outside controlled 429 rejections below 1%, and criterion 2
# (no duplicate event, one upstream caller) still true afterwards (p2-single-fetch.sh). The aggregator HPA is removed for the run and restored on exit.
#   [VUS=10000 THINK_S=100 DURATION_S=300]  scripts/m2/p2-load-10k.sh
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
VUS=${VUS:-10000}; THINK=${THINK_S:-100}; DUR=${DURATION_S:-300}; tmp=$(mktemp -d); HPA_SAVED=0
restore() { [ "$HPA_SAVED" = 1 ] && kubectl -n "$NS" apply -f "$tmp/hpa.json" >/dev/null 2>&1 && echo ">>> HPA restored"; kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap restore EXIT
if kubectl -n "$NS" get hpa aggregator-hpa >/dev/null 2>&1; then
  kubectl -n "$NS" get hpa aggregator-hpa -o json | jq 'del(.metadata.resourceVersion,.metadata.uid,.metadata.creationTimestamp,.metadata.managedFields,.status)' > "$tmp/hpa.json"; kubectl -n "$NS" delete hpa aggregator-hpa >/dev/null; HPA_SAVED=1
fi
kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null; kubectl -n "$NS" rollout status deploy/aggregator --timeout=240s >/dev/null; sleep 15
echo ">>> $VUS virtual users, think time ${THINK}s (about $((VUS / THINK)) req/s once all are active), ${DUR}s in total"
START=$(date +%s)
BASE_URL=$API_URL AUTH_URL=$AUTH_URL CLIENT_SECRET=$(envget AUTH_CLIENT_BNPB_OPS_SECRET) VUS=$VUS THINK_S=$THINK DURATION_S=$DUR OUT="$tmp/out.json" node "$(dirname "$0")/../../load-test/vu-sim.mjs" > "$tmp/gen.log" 2>&1 &
GEN=$!
at() { local t=$1; while [ $(( $(date +%s) - START )) -lt "$t" ]; do sleep 1; done; }
at $((THINK + 30)); echo "t=$(( $(date +%s) - START ))s: scale 3 -> 5"; kubectl -n "$NS" scale deploy/aggregator --replicas=5 >/dev/null
at $((THINK + 75)); echo "t=$(( $(date +%s) - START ))s: scale 5 -> 2"; kubectl -n "$NS" scale deploy/aggregator --replicas=2 >/dev/null
at $((THINK + 120)); echo "t=$(( $(date +%s) - START ))s: rolling update (new revision)"; kubectl -n "$NS" set env deploy/aggregator ROLLOUT_VERSION="v$(date +%s)" >/dev/null
at $((THINK + 165)); echo "t=$(( $(date +%s) - START ))s: scale back to 3"; kubectl -n "$NS" scale deploy/aggregator --replicas=3 >/dev/null
wait "$GEN" || true
jq 'del(.seconds_with_errors)' "$tmp/out.json" 2>/dev/null || cat "$tmp/gen.log"
echo "seconds that had errors (second since start, count): $(jq -c '.seconds_with_errors' "$tmp/out.json")"
active_s=$(( DUR - THINK )); users=$(jq -r .max_concurrent_users "$tmp/out.json"); er=$(jq -r .error_rate_outside_429 "$tmp/out.json")
[ "$users" -ge 10000 ] && [ "$active_s" -ge 120 ] && pass "$users virtual users active, all of them for the last ${active_s}s (>= 120 s)" || fail "users $users, all-active window ${active_s}s"
awk -v e="$er" 'BEGIN{exit !(e<0.01)}' && pass "error rate outside controlled 429 rejections is $er (< 0.01) while scaling 3->5->2->3 and rolling" || fail "error rate $er (needs < 0.01)"
kubectl -n "$NS" rollout status deploy/aggregator --timeout=240s >/dev/null; sleep 20
"$(dirname "$0")/p2-single-fetch.sh" >"$tmp/sf.log" 2>&1 && pass "criterion 2 still holds after the load (no duplicates, one caller)" || { fail "criterion 2 broken after the load"; tail -5 "$tmp/sf.log"; }
finish
