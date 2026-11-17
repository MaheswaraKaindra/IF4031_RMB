#!/usr/bin/env bash
# P1 criteria 4 and 7 (partial path): make ONE WHOLE SHARD unreachable (both data members down, data kept on disk) and show
# that every request is still answered, explicitly marked partial with the unit name, and that the analytics dashboard
# banner condition (`partial: true`) holds; then restore it and verify nothing was lost.
#   scripts/k8s/p1-unit-loss.sh <shard 1|2|3>
# This is NOT the permanent-loss scenario (see p1-node-loss.sh): data stays on disk, so it comes back as it was.
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
SHARD=${1:?shard 1|2|3}
DOWN_SECONDS=${DOWN_SECONDS:-60}
members=$(data_members_of_shard "$SHARD")
[ -n "$members" ] || { echo "no such shard" >&2; exit 1; }
SNAP=$(mktemp -d); trap 'cleanup_pf; rm -rf "$SNAP"' EXIT
start_forward; start_client_forward

collect_ids "$SNAP/ids-before"
echo "before: $(wc -l < "$SNAP/ids-before" | tr -d ' ') records"

echo ">>> stopping both data members of shard-$SHARD: $(echo $members | tr '\n' ' ')"
for m in $members; do kubectl -n "$NS" scale statefulset "$m" --replicas=0 >/dev/null; done

partial_audit=0; partial_checksum=0; partial_analytics=0; partial_client=0; bad=0; complete_wrong=0
start=$(date +%s)
while [ $(( $(date +%s) - start )) -lt "$DOWN_SECONDS" ]; do
  if body=$(audit "/internal/audit/events?limit=1000"); then
    if [ "$(jq -r '.partial' <<<"$body")" = true ] && jq -e --arg u "shard-$SHARD" '.unavailable_units | index($u)' <<<"$body" >/dev/null; then partial_audit=$((partial_audit + 1)); else complete_wrong=$((complete_wrong + 1)); fi
  else bad=$((bad + 1)); echo "BAD audit events"; fi
  if body=$(audit "/internal/audit/checksum"); then [ "$(jq -r '.partial' <<<"$body")" = true ] && partial_checksum=$((partial_checksum + 1)); else bad=$((bad + 1)); echo "BAD checksum"; fi
  if body=$(audit "/internal/analytics/summary"); then [ "$(jq -r '.partial' <<<"$body")" = true ] && partial_analytics=$((partial_analytics + 1)); else bad=$((bad + 1)); echo "BAD analytics"; fi
  read -r code t part <<<"$(client_events)"
  if [ "$code" = 200 ]; then [ "$part" = partial ] && partial_client=$((partial_client + 1)); else bad=$((bad + 1)); echo "BAD client-api /events -> $code (${t}s)"; fi
  sleep 3
done
echo "while shard-$SHARD was unreachable: partial audit=$partial_audit checksum=$partial_checksum analytics=$partial_analytics client-api=$partial_client | answers not marked partial=$complete_wrong | bad=$bad"

echo ">>> restoring shard-$SHARD"
for m in $members; do kubectl -n "$NS" scale statefulset "$m" --replicas=1 >/dev/null; done
for _ in $(seq 1 120); do redundancy_ok && break; sleep 5; done
redundancy_ok || { echo "FAIL: redundancy not restored" >&2; exit 1; }
collect_ids "$SNAP/ids-after"
lost=$(LC_ALL=C comm -23 "$SNAP/ids-before" "$SNAP/ids-after" | wc -l | tr -d ' ')
rc=0
[ "$partial_audit" -gt 0 ] && [ "$complete_wrong" = 0 ] && echo "PASS: unreachable unit reported explicitly (partial:true, unavailable_units has shard-$SHARD)" || { echo "FAIL: partial marker missing" >&2; rc=1; }
[ "$partial_analytics" -gt 0 ] && echo "PASS: analytics flagged incomplete (dashboard shows the warning banner)" || { echo "FAIL: analytics not flagged" >&2; rc=1; }
[ "$bad" = 0 ] && echo "PASS: no 5xx / hung request" || { echo "FAIL: $bad bad answers" >&2; rc=1; }
[ "$lost" = 0 ] && echo "PASS: all records back after restore (lost=0)" || { echo "FAIL: $lost records missing after restore" >&2; rc=1; }
echo "also open http://<node>:30000/analytics during the outage to screenshot the banner (re-run with DOWN_SECONDS=300)"
exit $rc
