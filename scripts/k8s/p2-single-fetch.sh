#!/usr/bin/env bash
# P2 criterion 2: every source is fetched exactly once. No duplicate HazardEvent in the store, and the upstream mocks see ONE
# caller (the Lease holder) and not a multiple of the request rate.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
WINDOW=${WINDOW:-60}; POLL_S=${POLL_S:-3}
tmp=$(mktemp -d); trap 'cleanup_pf; rm -rf "$tmp"' EXIT
# Page the Audit API listing once and look for repeated identities in that single listing.
cursor=""; : > "$tmp/all"
while :; do
  body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}")
  jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"
  cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break
done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
echo "records listed: $(wc -l < "$tmp/all" | tr -d ' '), distinct: $(LC_ALL=C sort -u "$tmp/all" | wc -l | tr -d ' ')"
[ "$dups" = 0 ] && pass "no duplicate HazardEvent in the store (0 repeated source/source_ref_id)" || fail "$dups duplicated source/source_ref_id pairs"
for pair in "mock-bmkg:aggregator-poller-bmkg" "mock-pvmbg:aggregator-poller-pvmbg"; do
  mock=${pair%%:*}; lease=${pair##*:}
  holder=$(kubectl -n "$NS" get lease "$lease" -o jsonpath='{.spec.holderIdentity}')
  logs=$(kubectl -n "$NS" logs "deploy/$mock" --since="${WINDOW}s" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .caller_pod' 2>/dev/null || true)
  n=$(printf '%s\n' "$logs" | grep -c . || true); callers=$(printf '%s\n' "$logs" | grep . | sort -u | wc -l | tr -d ' ')
  max=$(( WINDOW / POLL_S * 3 / 2 + 2 ))
  [ "$n" -gt 0 ] || { fail "$mock: no upstream polls in the last ${WINDOW}s"; continue; }
  [ "$callers" = 1 ] && pass "$mock: one caller in ${WINDOW}s ($(printf '%s\n' "$logs" | grep . | sort -u))" || fail "$mock: $callers different callers in ${WINDOW}s"
  [ "$(printf '%s\n' "$logs" | grep . | sort -u)" = "$holder" ] && pass "$mock: the caller is the Lease holder ($holder)" || fail "$mock: caller is not the Lease holder ($holder)"
  [ "$n" -le "$max" ] && pass "$mock: $n polls in ${WINDOW}s (not multiplied, limit $max)" || fail "$mock: $n polls in ${WINDOW}s exceeds $max"
done

echo ">>> every source has exactly one leader, and the satellite feed and the coastal sensor have exactly one caller"
PODS=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}')
pod_metrics() { kubectl -n "$NS" exec "$1" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null; }
for p in $PODS; do pod_metrics "$p" > "$tmp/m1.$p" || true; done
sleep 20
for p in $PODS; do pod_metrics "$p" > "$tmp/m2.$p" || true; done
for src in BMKG PVMBG SATELIT SENSOR_PANTAI; do
  leaders=$(for p in $PODS; do awk -v s="aggregator_is_leader{source=\"$src\"}" '$1==s {print $2}' "$tmp/m2.$p"; done | awk '$1==1' | wc -l | tr -d ' ')
  [ "$leaders" = 1 ] && pass "$src: exactly one pod reports itself leader ($leaders of $(echo $PODS | wc -w))" || fail "$src: $leaders pods report themselves leader"
done
# coastal sensor: only the leader's request counter moves
movers=0; for p in $PODS; do a=$(awk '/^coastal_sensor_requests_total/ {s+=$NF} END{print s+0}' "$tmp/m1.$p"); b=$(awk '/^coastal_sensor_requests_total/ {s+=$NF} END{print s+0}' "$tmp/m2.$p"); [ "$(awk -v a="$a" -v b="$b" 'BEGIN{print (b>a)}')" = 1 ] && movers=$((movers + 1)); done
[ "$movers" = 1 ] && pass "SENSOR_PANTAI: exactly one pod sent requests to the sensor in 20 s" || fail "SENSOR_PANTAI: $movers pods sent requests to the sensor in 20 s"
# satellite: only the leader holds the stream (its processing counters move and the session monitor gauges exist on one pod)
holders=0; for p in $PODS; do grep -q '^satellite_source_latest_offset ' "$tmp/m2.$p" && holders=$((holders + 1)); done
if [ "$holders" = 0 ]; then echo "SKIP: SATELIT pipeline is off (no SATELLITE_GROUP_TOKEN in the secret)"
else [ "$holders" = 1 ] && pass "SATELIT: exactly one pod holds the feed connection ($holders)" || fail "SATELIT: $holders pods report feed state (more than one stream open)"; fi
finish
