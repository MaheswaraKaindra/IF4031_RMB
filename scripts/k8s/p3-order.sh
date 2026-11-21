#!/usr/bin/env bash
# P3 criterion 4 on the cluster: after a schema rule change, parked messages are replayed WITH THE PER-KEY ORDER KEPT.
#   key A: two versions of one report (Waspada, then Awas), both readable after the rule. Both must be recovered, in order of arrival
#          (processed_at of v1 before v2), and the stored event must carry the NEWER level (Awas).
#   key B: two versions where the FIRST stays unreadable after the rule. The second must NOT be applied ahead of it (blocked by key).
# The versions are stored in the parked inbox by dist/tools/inbox-tool.js exactly as the aggregator parks an unreadable message (the mock cannot
# serve several versions of one report); the LAST version is inserted first, with the latest received_at, so only an ordered replay passes.
# Needs the Internal Ops client secret in .env. Removes its own test data on exit and restores the schema rule.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ts=$(date +%s); KA="ORD-$ts-A"; KB="ORD-$ts-B"
pod=$(ready_pod aggregator)
tool() { kubectl -n "$NS" exec "$pod" -c aggregator -- node dist/tools/inbox-tool.js "$@" | { grep -v '"service":"aggregator"' || true; }; }
ops() { mint bnpb-ops AUTH_CLIENT_BNPB_OPS_SECRET; }
setrule() { curl -s -m 8 -X POST "$API_URL/unprocessed/schema-rules" -H "Authorization: Bearer $(ops)" -H 'content-type: application/json' -d "{\"enablePvmbgV2Compat\":$1}" >/dev/null; }
cleanup() { cleanup_pf; setrule false || true; tool purge --key "$KA" >/dev/null 2>&1 || true; tool purge --key "$KB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
setrule false
echo ">>> parking the versions"; tool park --key "$KA" --levels Waspada,Awas; tool park --key "$KB" --levels Waspada,Awas --poison-first
setrule true; sleep 3
echo ">>> replay (PVMBG)"; replay=$(curl -s -m 60 -X POST "$API_URL/unprocessed/replay" -H "Authorization: Bearer $(ops)" -H 'content-type: application/json' -d '{"source":"PVMBG"}'); echo "$replay"
sleep 2
A=$(tool show --key "$KA"); B=$(tool show --key "$KB"); echo "key A:"; echo "$A"; echo "key B:"; echo "$B"
pa=$(jq -s '[.[]|select(.status=="processed")]|length' <<<"$A")
order=$(jq -s 'sort_by(.received_at)|if length==2 and all(.[];.processed_at!=null) then (.[0].processed_at < .[1].processed_at) else false end' <<<"$A")
[ "$pa" = 2 ] && pass "key A: both versions recovered" || fail "key A: $pa of 2 recovered"
[ "$order" = true ] && pass "key A: version 1 was applied before version 2 (processed_at order = received order, although v2 was stored first)" || fail "key A: replay order wrong"
pvmbg_events() { local cursor="" body; while :; do body=$(audit "/internal/audit/events?source=PVMBG&limit=1000${cursor:+&cursor=$cursor}"); jq -c '.items[]' <<<"$body"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done; }
pvmbg_events > "${TMPDIR:-/tmp}/p3order.$$" ; EV="${TMPDIR:-/tmp}/p3order.$$"; trap 'cleanup; rm -f "$EV"' EXIT
sev=$(jq -rs --arg k "$KA" '[.[]|select(.source_ref_id==$k)]|if length==1 then .[0].severity else "count=\(length)" end' "$EV")
[ "$sev" = AWAS ] && pass "key A: exactly one stored event, with the newer level (AWAS)" || fail "key A: stored event is $sev"
b2=$(jq -s '[.[]|select(.status=="processed")]|length' <<<"$B"); bev=$(jq -s --arg k "$KB" '[.[]|select(.source_ref_id==$k)]|length' "$EV")
[ "$b2" = 0 ] && [ "$bev" = 0 ] && pass "key B: the unreadable first version blocks the later one (nothing processed, no event stored)" || fail "key B: $b2 processed, $bev events stored"
[ "$(jq -r '.blocked_by_key // 0' <<<"$replay")" -ge 1 ] && pass "replay reported blocked_by_key=$(jq -r '.blocked_by_key' <<<"$replay")" || fail "replay reported no blocked_by_key"
finish
