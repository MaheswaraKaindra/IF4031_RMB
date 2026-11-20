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
finish
