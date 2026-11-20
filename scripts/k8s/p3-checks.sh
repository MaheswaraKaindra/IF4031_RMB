#!/usr/bin/env bash
# P3 criteria 1-6 on the real cluster, with PASS/FAIL (replaces reading p3-verify.sh output by eye).
#   1/2  incompatible schema changes are parked (kept whole, with reason, source, time), compatible ones are accepted
#   3    malformed payloads do not crash or restart anything, other data keeps flowing
#   4    after a rule change the parked messages are replayed: fewer parked, no duplicates in the store
#   5    only BNPB Ops can inspect the parked messages
#   6    POST /field-reports answers 202 quickly even with the broker down, and no 202'd report is lost or doubled after the
#        aggregator pods are killed
# Restores the mock to baseline and RabbitMQ to its original replica count on exit.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
tmp=$(mktemp -d)
BROKER_REPLICAS=$(kubectl -n "$NS" get statefulset rabbitmq -o jsonpath='{.spec.replicas}')
restore() {
  cleanup_pf; rm -rf "$tmp"
  mock_admin mock-pvmbg 8082 /admin/schema-version '{"mode":"baseline"}' >/dev/null 2>&1 || true
  mock_admin mock-pvmbg 8082 /admin/malformed '{"mode":"none"}' >/dev/null 2>&1 || true
  kubectl -n "$NS" scale statefulset rabbitmq --replicas="$BROKER_REPLICAS" >/dev/null 2>&1 || true
}
trap restore EXIT

ops() { mint bnpb-ops AUTH_CLIENT_BNPB_OPS_SECRET; }
parked() { curl -s -m 8 -H "Authorization: Bearer $(ops)" "$API_URL/unprocessed?limit=1000" | jq -c '.items // []'; }
restarts() { kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o json | jq '[.items[].status.containerStatuses[]?.restartCount] | add // 0'; }
bmkg_count() { audit "/internal/audit/checksum?source=BMKG" | jq -r '.count'; }

echo ">>> 5. only BNPB Ops can inspect parked messages"
media=$(mint media AUTH_CLIENT_MEDIA_SECRET); field=$(mint field-team AUTH_CLIENT_FIELD_TEAM_SECRET)
code() { curl -s -m 5 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" "$API_URL/unprocessed"; }
[ "$(code "$media")" = 403 ] && pass "media -> /unprocessed is 403" || fail "media -> /unprocessed is $(code "$media")"
[ "$(code "$field")" = 403 ] && pass "field-team -> /unprocessed is 403" || fail "field-team -> /unprocessed is $(code "$field")"
[ "$(code "$(ops)")" = 200 ] && pass "bnpb-ops -> /unprocessed is 200" || fail "bnpb-ops -> /unprocessed is not 200"

echo ">>> 1/2. schema policy: additive accepted, incompatible parked with reason"
base_parked=$(parked | jq 'length'); r0=$(restarts)
mock_admin mock-pvmbg 8082 /admin/schema-version '{"mode":"additive"}' >/dev/null; sleep 15
add_parked=$(parked | jq 'length')
[ "$add_parked" = "$base_parked" ] && pass "additive change (new field) is accepted automatically, nothing parked" || fail "additive change parked $((add_parked - base_parked)) message(s)"
for mode in incompatible_rename incompatible_type incompatible_missing; do
  before=$(parked | jq 'length')
  mock_admin mock-pvmbg 8082 /admin/schema-version "{\"mode\":\"$mode\"}" >/dev/null; sleep 20
  after=$(parked | jq 'length')
  [ "$after" -gt "$before" ] && pass "$mode: $((after - before)) new message(s) parked" || fail "$mode: nothing was parked"
done
mock_admin mock-pvmbg 8082 /admin/schema-version '{"mode":"baseline"}' >/dev/null
all=$(parked)
jq -e 'length > 0 and all(.[]; (.reason|type=="string" and length>0) and (.source|type=="string") and (.received_at|type=="string") and (.retryable|type=="boolean"))' <<<"$all" >/dev/null \
  && pass "every parked message keeps its reason, source, time and a retryable flag" || fail "a parked message lacks reason/source/time/retryable"
jq -e 'any(.[]; .retryable==false)' <<<"$all" >/dev/null && pass "permanent failures are marked retryable=false" || fail "no message is marked as permanent"

echo ">>> 3. malformed payloads: no crash, no restart, other data keeps flowing"
b0=$(bmkg_count)
# The mock sends the same bytes every time and identical payloads are parked once, so assert that a parked message with the
# expected reason EXISTS (this also holds when the script is run twice).
declare -A WANT=([truncated_json]=malformed_json [deeply_nested]=max_depth_exceeded [invalid_utf8]=invalid_utf8 [oversized]=payload_too_large)
for mode in truncated_json deeply_nested invalid_utf8 oversized; do
  mock_admin mock-pvmbg 8082 /admin/malformed "{\"mode\":\"$mode\"}" >/dev/null; sleep 15
  parked | jq -e --arg w "${WANT[$mode]}" 'any(.[]; .reason | startswith($w))' >/dev/null \
    && pass "$mode: kept whole and parked as ${WANT[$mode]}" || fail "$mode: no parked message with reason ${WANT[$mode]}"
done
mock_admin mock-pvmbg 8082 /admin/malformed '{"mode":"none"}' >/dev/null
r1=$(restarts); [ "$r1" = "$r0" ] && pass "aggregator restart count unchanged ($r1)" || fail "aggregator restarted $((r1 - r0)) time(s)"
check "all aggregator pods Ready" all_ready aggregator
b1=$(bmkg_count); [ "$b1" -gt "$b0" ] && pass "BMKG kept flowing ($b0 -> $b1 records)" || fail "BMKG stopped while PVMBG sent malformed data"

echo ">>> 4. replay: fewer parked, no duplicates"
before=$(parked | jq '[.[] | select(.status=="parked")] | length')
rules=$(curl -s -m 8 -X POST "$API_URL/unprocessed/schema-rules" -H "Authorization: Bearer $(ops)" -H 'content-type: application/json' -d '{"enablePvmbgV2Compat":true}')
echo "schema rules: $rules" | cut -c1-200
replay=$(curl -s -m 20 -X POST "$API_URL/unprocessed/replay" -H "Authorization: Bearer $(ops)" -H 'content-type: application/json' -d '{"source":"PVMBG"}')
echo "replay: $replay"
sleep 10
after=$(parked | jq '[.[] | select(.status=="parked")] | length')
rec=$(jq -r '.recovered // 0' <<<"$replay" 2>/dev/null || echo 0); still=$(jq -r '.still_failed // 0' <<<"$replay" 2>/dev/null || echo 0)
[ "$rec" -gt 0 ] && pass "replay recovered $rec message(s); $still stay parked because they cannot be read without a code change" || fail "replay recovered nothing (response: $replay)"
[ "$after" -lt "$before" ] && pass "parked messages went from $before to $after" || fail "parked messages did not decrease ($before -> $after)"
cursor=""; : > "$tmp/all"
while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}"); jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && pass "no duplicate HazardEvent after the replay" || fail "$dups duplicates after the replay"
curl -s -m 8 -X POST "$API_URL/unprocessed/schema-rules" -H "Authorization: Bearer $(ops)" -H 'content-type: application/json' -d '{"enablePvmbgV2Compat":false}' >/dev/null || true

echo ">>> 6. durable 202 with the broker down and every aggregator killed right after"
N=${REPORTS:-20}; run=$(date +%s); ft=$(mint field-team AUTH_CLIENT_FIELD_TEAM_SECRET)
kubectl -n "$NS" scale statefulset rabbitmq --replicas=0 >/dev/null; sleep 8
acc=0; slow=0; : > "$tmp/accepted"
for i in $(seq 1 "$N"); do
  id="FR-P3-$run-$i"
  out=$(curl -s -m 5 -o "$tmp/body" -w '%{http_code} %{time_total}' -X POST "$API_URL/field-reports" -H "Authorization: Bearer $ft" -H "Idempotency-Key: k-$id" -H 'content-type: application/json' \
    -d "{\"report_id\":\"$id\",\"hazard_type\":\"COASTAL\",\"severity\":\"AWAS\",\"area_name\":\"Padang\",\"latitude\":-0.95,\"longitude\":100.35,\"occurred_at\":\"2026-11-20T12:00:00Z\"}")
  read -r c t <<<"$out"
  if [ "$c" = 202 ]; then acc=$((acc + 1)); echo "$id" >> "$tmp/accepted"; jq -en --arg t "$t" '($t|tonumber) > 1' >/dev/null && slow=$((slow + 1)); fi
done
[ "$acc" = "$N" ] && pass "$N/$N reports answered 202 while the broker was down" || fail "only $acc/$N reports answered 202 with the broker down"
[ "$slow" = 0 ] && pass "all 202 answers took under 1 s" || fail "$slow answer(s) took more than 1 s"
kubectl -n "$NS" delete pods -l app.kubernetes.io/name=aggregator --wait=false >/dev/null
kubectl -n "$NS" scale statefulset rabbitmq --replicas="$BROKER_REPLICAS" >/dev/null
wait_for 240 all_ready aggregator && pass "aggregator pods recovered on their own" || fail "aggregator did not recover within 240 s"
sleep 20
cursor=""; : > "$tmp/fr"
while :; do body=$(audit "/internal/audit/events?source=FIELD_REPORT&limit=1000${cursor:+&cursor=$cursor}"); jq -r '.items[].source_ref_id' <<<"$body" >> "$tmp/fr"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
lost=0; doubled=0
while read -r id; do n=$(grep -cx "$id" "$tmp/fr" || true); [ "$n" = 0 ] && lost=$((lost + 1)); [ "$n" -gt 1 ] && doubled=$((doubled + 1)); done < "$tmp/accepted"
[ "$lost" = 0 ] && pass "no 202'd report was lost" || fail "$lost report(s) answered 202 but are not stored"
[ "$doubled" = 0 ] && pass "no report was stored twice" || fail "$doubled report(s) stored more than once"
finish
