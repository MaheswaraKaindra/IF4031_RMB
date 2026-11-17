#!/usr/bin/env bash
# P1 criteria 4, 5, 6: lose ALL storage on one node slot, keep asking questions, replace it with an empty disk, verify.
#   scripts/k8s/p1-node-loss.sh <slot 1|2|3> [--manual]
# Default mode SIMULATES permanent node+disk loss: it stops every store member pinned to that slot and deletes their
# PVCs (verified gone), keeps them down for DOWN_SECONDS, then lets them restart on NEW empty volumes (= a replacement
# node with an empty disk) and re-sync. On the real cluster prefer --manual: destroy/wipe the VM yourself (or run the
# Tester Agent scenario) while this script monitors and then verifies.
#
# What a single-node loss looks like: every shard keeps one readable data member, so answers stay COMPLETE; writes to the
# affected shards are acknowledged `degraded` (single copy) until re-sync. To demonstrate the explicit PARTIAL path use
# scripts/k8s/p1-unit-loss.sh (a whole shard unreachable).
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
SLOT=${1:?slot 1|2|3}; MANUAL=${2:-}
DOWN_SECONDS=${DOWN_SECONDS:-45}
MONITOR_SECONDS=${MONITOR_SECONDS:-150}
members=$(members_of_slot "$SLOT")
[ -n "$members" ] || { echo "no members for slot $SLOT" >&2; exit 1; }
SNAP=$(mktemp -d); WIPED=0
# If the run dies between the wipe and the restore, never leave the slot's members stopped.
trap 'cleanup_pf; rm -rf "$SNAP"; [ "$WIPED" = 1 ] && { echo "restoring members after an aborted run" >&2; for m in $members; do kubectl -n "$NS" scale statefulset "$m" --replicas=1 >/dev/null; done; }' EXIT
start_forward; start_client_forward

echo ">>> precondition: redundancy intact (needed to survive the NEXT loss, criterion 6)"
if ! redundancy_ok; then
  [ "${FORCE:-0}" = 1 ] && echo "(forced)" || { echo "FAIL: redundancy not restored yet; wait or use FORCE=1" >&2; exit 1; }
fi
collect_ids "$SNAP/ids-before"; snapshot "$SNAP/before.jsonl"
echo "before: $(wc -l < "$SNAP/ids-before" | tr -d ' ') records"; jq -c . "$SNAP/before.jsonl"

complete=0; partial=0; bad=0; slow=0; client_ok=0
probe_once() {
  local path body code t part
  for path in "/internal/audit/events?limit=50" "/internal/audit/checksum" "/internal/analytics/summary"; do
    if body=$(audit "$path"); then
      if [ "$(jq -r '.partial' <<<"$body")" = true ]; then partial=$((partial + 1)); echo "partial  $path unavailable=$(jq -c '.unavailable_units' <<<"$body")"; else complete=$((complete + 1)); fi
    else bad=$((bad + 1)); echo "BAD      $path"; fi
  done
  read -r code t part <<<"$(client_events)"
  if [ "$code" = 200 ]; then
    client_ok=$((client_ok + 1)); [ "$part" = partial ] && echo "partial  client-api /events (flagged)"
    jq -en --arg t "$t" '($t|tonumber) > 2' >/dev/null && { slow=$((slow + 1)); echo "SLOW     client-api /events ${t}s"; }
  else bad=$((bad + 1)); echo "BAD      client-api /events -> $code (${t}s)"; fi
  return 0   # the last list above may legitimately be "false"; under set -e that would abort the whole run
}

if [ "$MANUAL" = "--manual" ]; then
  echo ">>> MANUAL: destroy/wipe the node holding slot $SLOT now (members: $(echo $members | tr '\n' ' ')). Monitoring ${MONITOR_SECONDS}s."
  start=$(date +%s); while [ $(( $(date +%s) - start )) -lt "$MONITOR_SECONDS" ]; do probe_once; sleep 3; done
else
  echo ">>> simulating permanent loss of slot $SLOT: $(echo $members | tr '\n' ' ')"
  WIPED=1; wipe_members "$SNAP" $members
  echo ">>> node gone; monitoring for ${DOWN_SECONDS}s before the replacement (empty disk) joins"
  start=$(date +%s); while [ $(( $(date +%s) - start )) -lt "$DOWN_SECONDS" ]; do probe_once; sleep 3; done
  restore_members "$SNAP" 1 $members; WIPED=0
  echo ">>> replacement joined with empty disks; monitoring until MONITOR_SECONDS=${MONITOR_SECONDS}s"
  start=$(date +%s); while [ $(( $(date +%s) - start )) -lt "$MONITOR_SECONDS" ]; do probe_once; sleep 3; done
fi
echo "answers: audit/analytics complete=$complete explicit_partial=$partial | client-api ok=$client_ok slow(>2s)=$slow | bad=$bad"

echo ">>> waiting for re-sync / redundancy (up to 20 min)"
for _ in $(seq 1 120); do redundancy_ok && break; sleep 10; done
redundancy_ok && echo "redundancy restored: $(members_json | jq -c 'group_by(.unit) | map({unit: .[0].unit, counts: map(.count)})')" \
  || { echo "FAIL: redundancy not restored" >&2; exit 1; }

collect_ids "$SNAP/ids-after"; snapshot "$SNAP/after.jsonl"
lost=$(LC_ALL=C comm -23 "$SNAP/ids-before" "$SNAP/ids-after" | wc -l | tr -d ' ')
echo "records before=$(wc -l < "$SNAP/ids-before" | tr -d ' ') after=$(wc -l < "$SNAP/ids-after" | tr -d ' ') lost=$lost"
echo "after (evidence; counts may be higher because ingestion continued):"; jq -c . "$SNAP/after.jsonl"
rc=0
[ "$lost" = 0 ] && echo "PASS: no HazardEvent lost (every pre-loss record is still stored)" || { echo "FAIL: $lost records lost" >&2; rc=1; }
[ "$bad" = 0 ] && echo "PASS: no 5xx / hung request during the loss and recovery" || { echo "FAIL: $bad bad answers" >&2; rc=1; }
[ "$slow" = 0 ] || echo "WARN: $slow client-api answers took more than 2s (client-api upstream timeout); check STORE_DEADLINE_MS"
echo "next: run again with a DIFFERENT slot to prove the system survives the next loss (criterion 6)"
exit $rc
