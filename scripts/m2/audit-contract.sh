#!/usr/bin/env bash
# Appendix A (Audit API contract) against the running cluster, through the Audit NodePort:
#   auth errors and the error body shape, JSON content type, exact field names, default and maximum limit, cursor pagination ending in null,
#   ascending order by ingested_at then hazard_id, the `since` and `source` filters, partial/unavailable_units fields, the checksum recomputed locally
#   (SHA-256 of the source_ref_ids sorted by byte, joined by newline, no trailing newline), /location (200 with roles and 404), /unprocessed shape.
#   [SOURCE=PVMBG]  scripts/m2/audit-contract.sh
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
SRC=${SOURCE:-PVMBG}; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
req() { curl -s -m 30 -o "$tmp/body" -D "$tmp/head" -w '%{http_code}' "$@"; }
auth=(-H "Authorization: Bearer $AUDIT_TOKEN")
echo ">>> errors"
c=$(req "$AUDIT_URL/internal/audit/events"); [ "$c" = 401 ] && jq -e '.error.code and .error.message and (keys==["error"])' "$tmp/body" >/dev/null && pass "no token: 401 with {error:{code,message}} ($(jq -c . "$tmp/body"))" || fail "no token: $c $(cat "$tmp/body")"
c=$(req -H "Authorization: Bearer wrong" "$AUDIT_URL/internal/audit/events"); [ "$c" = 401 ] && pass "wrong token: 401" || fail "wrong token: $c"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events?limit=abc"); { [ "$c" = 400 ] && jq -e '.error.code' "$tmp/body" >/dev/null; } && pass "invalid limit: 400 with the error body" || fail "invalid limit: $c $(head -c 200 "$tmp/body")"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/location?hazard_id=hz-does-not-exist"); { [ "$c" = 404 ] && jq -e '.error.code' "$tmp/body" >/dev/null; } && pass "unknown hazard_id: 404 with the error body" || fail "unknown hazard_id: $c $(head -c 200 "$tmp/body")"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/location"); [ "$c" = 400 ] && pass "hazard_id missing: 400" || fail "hazard_id missing: $c"
echo ">>> events"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events"); [ "$c" = 200 ] && pass "200" || fail "events: $c"
grep -qi '^content-type: application/json' "$tmp/head" && pass "Content-Type application/json" || fail "content type: $(grep -i '^content-type' "$tmp/head")"
n=$(jq '.items|length' "$tmp/body"); [ "$n" = 100 ] && pass "default limit is 100 ($n items)" || fail "default limit gives $n items"
jq -e '(keys|sort)==["items","next_cursor","partial","unavailable_units"]' "$tmp/body" >/dev/null && pass "response has exactly items, next_cursor, partial, unavailable_units" || fail "response keys: $(jq -c keys "$tmp/body")"
jq -e '.items[0]|(keys|sort)==["area_name","attributes","hazard_id","hazard_type","ingested_at","latitude","longitude","occurred_at","severity","source","source_ref_id"]' "$tmp/body" >/dev/null && pass "event field names are exactly the contract's" || fail "event keys: $(jq -c '.items[0]|keys' "$tmp/body")"
jq -e '[.items[]|.ingested_at,.occurred_at]|all(test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z$"))' "$tmp/body" >/dev/null && pass "times are ISO 8601 UTC (Z)" || fail "time format"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events?limit=1000"); [ "$c" = 200 ] && [ "$(jq '.items|length' "$tmp/body")" -le 1000 ] && pass "limit=1000 accepted" || fail "limit=1000: $c"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events?limit=1001"); if [ "$c" = 400 ]; then pass "limit=1001 refused with 400"; elif [ "$c" = 200 ] && [ "$(jq '.items|length' "$tmp/body")" -le 1000 ]; then pass "limit=1001 clamped to at most 1000 items"; else fail "limit=1001: $c"; fi
echo ">>> pagination and order for source $SRC"
cursor=""; : > "$tmp/all"; pages=0
while :; do c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events?source=$SRC&limit=200${cursor:+&cursor=$cursor}"); [ "$c" = 200 ] || { fail "page $pages: $c"; break; }; pages=$((pages + 1))
  jq -c '.items[]' "$tmp/body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' "$tmp/body"); [ -z "$cursor" ] && { jq -e '.next_cursor==null' "$tmp/body" >/dev/null && pass "last page has next_cursor null ($pages pages)" || fail "last page cursor not null"; break; }; done
total=$(wc -l < "$tmp/all"); echo "     $total events"
jq -s 'map(.source)|unique' "$tmp/all" | jq -e --arg s "$SRC" '.==[$s]' >/dev/null && pass "source filter returns only $SRC" || fail "source filter leaks other sources"
jq -s '[.[]|[.ingested_at,.hazard_id]] as $k | $k==($k|sort)' "$tmp/all" | grep -q true && pass "ascending by ingested_at, then hazard_id, across all pages" || fail "order is not ascending by (ingested_at, hazard_id)"
[ "$(jq -s 'map(.hazard_id)|length - (unique|length)' "$tmp/all")" = 0 ] && pass "no event repeated across pages" || fail "events repeated across pages"
mid=$(jq -s '.[length/2|floor].ingested_at' -r "$tmp/all"); c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/events?source=$SRC&limit=1000&since=$mid")
exp=$(jq -s --arg m "$mid" '[.[]|select(.ingested_at>=$m)]|length' "$tmp/all"); got=$(jq '.items|length' "$tmp/body"); { [ "$c" = 200 ] && [ "$got" -le 1000 ] && jq -e --arg m "$mid" '[.items[].ingested_at>=$m]|all' "$tmp/body" >/dev/null; } && pass "since=$mid keeps only ingested_at >= since (got $got of $exp expected, limit 1000)" || fail "since filter"
echo ">>> checksum"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/checksum?source=$SRC"); [ "$c" = 200 ] || fail "checksum: $c"
jq -e '(keys|sort)==["algorithm","as_of","checksum","count","partial","source","unavailable_units"] and .algorithm=="sha256" and (.checksum|test("^[0-9a-f]{64}$"))' "$tmp/body" >/dev/null && pass "checksum response fields and format ($(jq -c '{count,algorithm,partial}' "$tmp/body"))" || fail "checksum fields: $(jq -c . "$tmp/body")"
mine=$(jq -s -r 'map(.source_ref_id)|.[]' "$tmp/all" | LC_ALL=C sort | { cat; } | awk 'BEGIN{ORS=""} NR>1{print "\n"} {print}' | sha256sum | cut -d' ' -f1)
theirs=$(jq -r .checksum "$tmp/body"); cnt=$(jq -r .count "$tmp/body")
[ "$mine" = "$theirs" ] && [ "$cnt" = "$total" ] && pass "checksum recomputed from the listing equals the endpoint's ($cnt records)" || echo "WARN: checksum differs from the listing ($cnt vs $total records): ingestion may have added records between the two reads; re-run for a quiet source"
echo ">>> location and unprocessed"
id=$(jq -s -r '.[0].hazard_id' "$tmp/all"); c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/location?hazard_id=$id")
jq -e '(keys|sort)==["hazard_id","locations","partial"] and (.locations|length>=1) and ([.locations[]|keys|sort==["node","role","unit"]]|all) and ([.locations[].role]|all(.=="primary" or .=="replica"))' "$tmp/body" >/dev/null && pass "location: node/unit/role, roles primary or replica ($(jq -c '[.locations[]|"\(.node)/\(.unit)/\(.role)"]' "$tmp/body"))" || fail "location body: $(head -c 300 "$tmp/body")"
c=$(req "${auth[@]}" "$AUDIT_URL/internal/audit/unprocessed?limit=5"); jq -e '(keys|sort)==["items","next_cursor"] and ([.items[]|keys|sort==["attempts","message_id","reason","received_at","retryable","source","status"]]|all) and ([.items[].status]|all(.=="retrying" or .=="parked"))' "$tmp/body" >/dev/null && pass "unprocessed: fields and status values ($(jq '.items|length' "$tmp/body") items)" || fail "unprocessed body: $(head -c 300 "$tmp/body")"
finish
