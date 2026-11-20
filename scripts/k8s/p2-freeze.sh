#!/usr/bin/env bash
# P2 criterion 5: the node that is fetching freezes (VM suspended, laptop lid closed) for longer than the lease, then wakes up
# believing it is still the leader. Show it stores nothing after waking up until its state is refreshed, and that nothing is doubled.
#   VM_PAUSE_CMD='VBoxManage.exe controlvm {node} pause' VM_RESUME_CMD='VBoxManage.exe controlvm {node} resume' scripts/k8s/p2-freeze.sh
# FREEZE_S (default 28) must exceed the lease (20 s) and stay below node eviction (about 36 s), so the pod is still there when it wakes.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
FREEZE=${FREEZE_S:-28}; LEASE=${LEASE:-aggregator-poller-bmkg}
tmp=$(mktemp -d); VICTIM=""; PAUSED=0
restore() { [ "$PAUSED" = 1 ] && { echo ">>> resuming $VICTIM"; vm_do resume "$VICTIM" || true; node_ready_wait "$VICTIM" 120 || true; }; cleanup_pf; rm -rf "$tmp"; }
trap restore EXIT

old=$(lease_holder "$LEASE"); VICTIM=$(pod_node "$old"); SOURCE=${LEASE##*-}; SOURCE=${SOURCE^^}
echo "leader of $LEASE: $old on $VICTIM"
use_survivor "$VICTIM"
trans0=$(lease_transitions "$LEASE")
collect_ids "$tmp/before"
echo ">>> freezing $VICTIM for ${FREEZE}s"
vm_do pause "$VICTIM"; PAUSED=1; T_FREEZE=$(date -u +%FT%TZ); sleep "$FREEZE"
new=""; for i in $(seq 1 20); do h=$(lease_holder "$LEASE"); [ "$h" != "$old" ] && [ -n "$h" ] && { new=$h; break; }; sleep 1; done
[ -n "$new" ] && pass "another instance ($new) holds the lease while $old is frozen" || fail "nobody took the lease over during the freeze"
echo ">>> waking $VICTIM"; vm_do resume "$VICTIM"; PAUSED=0; T_WAKE=$(date -u +%FT%TZ)
# the woken instance must stop acting as leader quickly
lost=""; for i in $(seq 1 30); do
  st=$(kubectl -n "$NS" exec "$old" -c aggregator -- wget -qO- -T 2 http://127.0.0.1:3000/health 2>/dev/null | jq -r --arg s "$SOURCE" '.leadership[$s] | "\(.isLeader) \(.valid)"' 2>/dev/null || echo "unreachable")
  case "$st" in "false "*|"unreachable") lost=$i; break;; esac; sleep 1; done
[ -n "$lost" ] && pass "the woken instance stopped acting as leader after ~${lost}s ($st)" || fail "the woken instance still claims to be the leader after 30 s"
sleep 30
# what did the woken instance manage to do after waking up?
polls=$(kubectl -n "$NS" logs "deploy/mock-${SOURCE,,}" --since-time="$T_WAKE" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .caller_pod' | grep -c "^$old$" || true)
rej=$(kubectl -n "$NS" logs "$old" -c aggregator --since-time="$T_WAKE" 2>/dev/null | grep -ciE 'stale_epoch|stale epoch|fenced|revoked' || true)
echo "after waking: upstream polls by the old leader=$polls, fencing/revocation log lines=$rej"
[ "$polls" -le 2 ] && pass "the woken instance made at most $polls upstream poll(s) before it noticed" || fail "the woken instance kept polling ($polls polls) after a new leader existed"
cursor=""; : > "$tmp/all"
while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || { fail "Audit API did not answer"; break; }
  jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && pass "no duplicate HazardEvent after the freeze" || fail "$dups duplicate HazardEvent(s)"
LC_ALL=C sort -u "$tmp/all" > "$tmp/after"; miss=$(LC_ALL=C comm -23 "$tmp/before" "$tmp/after" | wc -l | tr -d ' ')
[ "$miss" = 0 ] && pass "no record lost" || fail "$miss record(s) lost"
echo "leadership changes: $(( $(lease_transitions "$LEASE") - trans0 ))"
finish
