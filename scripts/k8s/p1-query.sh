#!/usr/bin/env bash
# P1 criterion 3 + Audit API contract: global ordering and pagination across all storage units.
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
start_forward
echo ">>> paging /internal/audit/events (limit=500) to the end"
cursor=""; : > /tmp/p1-audit.$$; pages=0
while :; do
  body=$(audit "/internal/audit/events?limit=500${cursor:+&cursor=$cursor}")
  jq -c '.items[]' <<<"$body" >> /tmp/p1-audit.$$
  pages=$((pages + 1)); cursor=$(jq -r '.next_cursor // empty' <<<"$body")
  [ -z "$cursor" ] && break
done
total=$(wc -l < /tmp/p1-audit.$$ | tr -d ' ')
dups=$(jq -r '.hazard_id' /tmp/p1-audit.$$ | sort | uniq -d | wc -l | tr -d ' ')
unsorted=$(jq -s '[.[] | [.ingested_at, .hazard_id]] | . as $a | [range(1; length) | select($a[.-1] > $a[.])] | length' /tmp/p1-audit.$$)
echo "pages=$pages records=$total duplicates=$dups order_violations=$unsorted"
rm -f /tmp/p1-audit.$$
[ "$dups" = 0 ] && [ "$unsorted" = 0 ] && echo "PASS: complete, unique and (ingested_at, hazard_id)-ordered" || { echo "FAIL" >&2; exit 1; }

echo ">>> 50 most recent events of ALL hazard types (occurred_at desc) through the internal read path"
body=$(kubectl -n "$NS" exec deploy/aggregator -- node -e '
  fetch("http://127.0.0.1:3000/internal/events?limit=50").then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))')
n=$(jq '.events | length' <<<"$body")
bad=$(jq '[.events | . as $e | range(1; length) | select($e[.-1].occurred_at < $e[.].occurred_at)] | length' <<<"$body")
echo "events=$n order_violations=$bad types=$(jq -c '[.events[].hazard_type] | unique' <<<"$body") partial=$(jq '.partial // false' <<<"$body")"
[ "$n" -gt 0 ] && [ "$bad" = 0 ] && echo "PASS" || { echo "FAIL" >&2; exit 1; }
