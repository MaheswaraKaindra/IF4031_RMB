#!/usr/bin/env bash
# P2 criterion 3: when the instance that is fetching dies (its whole node is powered off), another instance continues within
# <= 60 s, with no gap in the data and no duplicate.
#   VM_STOP_CMD='VBoxManage.exe controlvm {node} poweroff' VM_START_CMD='VBoxManage.exe startvm {node} --type headless' \
#   SSH_USER=<vm user> scripts/k8s/p2-failover.sh
# Measures: time until a Lease holder on ANOTHER node exists for every polled source, the longest pause between two upstream polls,
# the number of leadership changes, duplicates in the store, and whether every event the mock produced is stored.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
LIMIT=${TAKEOVER_LIMIT_S:-60}; SETTLE=${SETTLE_S:-60}
LEASES=${LEASES:-aggregator-poller-bmkg aggregator-poller-pvmbg}
tmp=$(mktemp -d); VICTIM=""; STOPPED=0
restore() {
  cleanup_pf
  if [ "$STOPPED" = 1 ]; then echo ">>> starting $VICTIM again"; vm_do start "$VICTIM" || true; node_ready_wait "$VICTIM" 300 || echo "WARN: $VICTIM did not return Ready within 300 s"; fi
  rm -rf "$tmp"
}
trap restore EXIT

first=${LEASES%% *}; leader=$(lease_holder "$first"); VICTIM=$(pod_node "$leader")
echo "leader of $first: $leader on $VICTIM"
use_survivor "$VICTIM"
declare -A before_holder=() before_trans=()
AFFECTED=""
for l in $LEASES; do
  before_holder[$l]=$(lease_holder "$l"); before_trans[$l]=$(lease_transitions "$l")
  [ "$(pod_node "${before_holder[$l]}")" = "$VICTIM" ] && AFFECTED="$AFFECTED $l"
done
AFFECTED=${AFFECTED# }
echo "leases led from $VICTIM (they must move): ${AFFECTED:-none}"
[ -n "$AFFECTED" ] || { echo "no lease is held from $VICTIM; nothing to fail over" >&2; exit 1; }
for m in mock-bmkg mock-pvmbg; do
  mn=$(kubectl -n "$NS" get pods -l "app.kubernetes.io/name=$m" -o jsonpath='{.items[0].spec.nodeName}')
  [ "$mn" = "$VICTIM" ] && echo "WARN: $m runs on $VICTIM; its logs vanish with the node, so the poll-gap check is skipped for it" && eval "SKIP_${m//-/_}=1"
done
collect_ids "$tmp/before"; echo "records before: $(wc -l < "$tmp/before" | tr -d ' ')"

t0=$(date +%s.%N); T0_ISO=$(date -u +%FT%TZ)
echo ">>> powering off $VICTIM"; vm_do stop "$VICTIM"; STOPPED=1
declare -A took=()
deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ] && [ "${#took[@]}" -lt "$(wc -w <<<"$AFFECTED")" ]; do
  for l in $AFFECTED; do
    [ -n "${took[$l]:-}" ] && continue
    h=$(lease_holder "$l"); [ -z "$h" ] && continue
    if [ "$h" != "${before_holder[$l]}" ] && [ "$(pod_node "$h")" != "$VICTIM" ] && pod_ready "$h"; then took[$l]=$(awk -v n="$(date +%s.%N)" -v s="$t0" 'BEGIN{printf "%.1f", n-s}'); echo "$l: new holder $h after ${took[$l]} s"; fi
  done; sleep 0.5
done
for l in $AFFECTED; do
  [ -n "${took[$l]:-}" ] || { fail "$l: no takeover within 180 s"; continue; }
  awk -v t="${took[$l]}" -v m="$LIMIT" 'BEGIN{exit !(t<=m)}' && pass "$l: another instance took over after ${took[$l]} s (limit $LIMIT s)" || fail "$l: takeover took ${took[$l]} s (limit $LIMIT s)"
done
echo ">>> letting the system settle for ${SETTLE}s"; sleep "$SETTLE"
for l in $LEASES; do
  n=$(( $(lease_transitions "$l") - ${before_trans[$l]} ))
  [ "$n" -le 2 ] && pass "$l: $n leadership change(s) after the loss (a stable takeover needs 1; 2 is the observed worst case)" || fail "$l: $n leadership changes, leadership is flapping"
  echo "     final holder: $(lease_holder "$l") on $(pod_node "$(lease_holder "$l")")"
done

# longest pause between two upstream polls after the loss, per mock
for pair in mock-bmkg:aggregator-poller-bmkg:SKIP_mock_bmkg mock-pvmbg:aggregator-poller-pvmbg:SKIP_mock_pvmbg; do
  m=${pair%%:*}; rest=${pair#*:}; ls=${rest%%:*}; sk=${rest##*:}
  case " $AFFECTED " in *" $ls "*) ;; *) continue;; esac
  [ -n "${!sk:-}" ] && continue
  times=$(kubectl -n "$NS" logs "deploy/$m" --since-time="$T0_ISO" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .time' | sort)
  [ -n "$times" ] || { fail "$m: no polls logged after the loss"; continue; }
  gap=$(printf '%s\n' "$times" | while read -r t; do date -u -d "$t" +%s.%N; done | awk 'NR>1{d=$1-p; if(d>m)m=d} {p=$1} END{printf "%.1f", m}')
  awk -v g="$gap" -v l="$LIMIT" 'BEGIN{exit !(g<=l)}' && pass "$m: longest pause between upstream polls was $gap s (<= $LIMIT s)" || fail "$m: upstream polling paused $gap s"
  callers=$(kubectl -n "$NS" logs "deploy/$m" --since-time="$T0_ISO" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .caller_pod' | sort -u | wc -l | tr -d ' ')
  echo "     distinct callers since the loss: $callers (old leader until it died, then the new one)"
done

# no duplicate and no gap in the store
cursor=""; : > "$tmp/all"
while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || { fail "Audit API did not answer after the failover"; break; }
  jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && pass "no duplicate HazardEvent after the failover" || fail "$dups duplicate HazardEvent(s)"
LC_ALL=C sort -u "$tmp/all" > "$tmp/after"
lost=$(LC_ALL=C comm -23 "$tmp/before" "$tmp/after" | wc -l | tr -d ' ')
[ "$lost" = 0 ] && pass "no record stored before the loss went missing" || fail "$lost record(s) missing after the failover"
if [ -z "${SKIP_mock_bmkg:-}" ]; then
  kubectl -n "$NS" port-forward svc/mock-bmkg 18081:8081 >/dev/null 2>&1 & pf=$!; sleep 3
  curl -s -m 10 -H "X-BMKG-Key: $(envget X_BMKG_KEY)" localhost:18081/seismic-events | jq -r '.[].event_id' | sed 's/^/BMKG|/' | LC_ALL=C sort -u > "$tmp/mock"
  kill "$pf" 2>/dev/null; wait "$pf" 2>/dev/null || true
  missing=$(LC_ALL=C comm -23 "$tmp/mock" "$tmp/after" | wc -l | tr -d ' ')
  [ "$missing" = 0 ] && pass "every event the BMKG mock produced ($(wc -l < "$tmp/mock" | tr -d ' ')) is stored: no gap" || fail "$missing mock event(s) never reached the store (data gap)"
fi
finish
