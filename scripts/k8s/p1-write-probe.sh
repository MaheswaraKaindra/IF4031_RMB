#!/usr/bin/env bash
# P1 criterion 5: writes keep being accepted while a node is lost and while its replacement re-syncs, and nothing accepted is lost.
#   scripts/k8s/p1-write-probe.sh <seconds> [<start-command>]
# Posts one field report every 0.5 s through the client-api NodePort of a node that stays up (unique report_id and Idempotency-Key), records the HTTP code
# and latency of each, and after the window waits for the cluster to settle and checks that EVERY report answered 202 is in the store (Audit API) exactly once.
# Run the loss in another shell (p1-node-loss.sh, a real power-off, ...) or pass a command that is started 10 s after the first write.
#   NODE_IP=<ip of a surviving node>   PROBE_URL_TIMEOUT=10
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
SECS=${1:?seconds}; CMD=${2:-}; run=$(date +%s); tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
: > "$tmp/res"; : > "$tmp/accepted"
ft() { mint field-team AUTH_CLIENT_FIELD_TEAM_SECRET; }
tok=$(ft); tok_at=$(date +%s)
[ -n "$CMD" ] && { ( sleep 10; echo ">>> $(date -u +%T) starting the loss: $CMD"; bash -c "$CMD" > "$tmp/cmd.out" 2>&1 ) & CP=$!; }
end=$(( $(date +%s) + SECS )); i=0
while [ "$(date +%s)" -lt "$end" ]; do
  i=$((i + 1)); [ $(( $(date +%s) - tok_at )) -gt 45 ] && { tok=$(ft); tok_at=$(date +%s); }
  id="WP-$run-$i"
  out=$(curl -s -m "${PROBE_URL_TIMEOUT:-10}" -o /dev/null -w '%{http_code} %{time_total}' -X POST "$API_URL/field-reports" -H "Authorization: Bearer $tok" -H "Idempotency-Key: k-$id" -H 'content-type: application/json' \
    -d "{\"report_id\":\"$id\",\"hazard_type\":\"COASTAL\",\"severity\":\"AWAS\",\"area_name\":\"Padang\",\"latitude\":-0.95,\"longitude\":100.35,\"occurred_at\":\"$(date -u +%FT%TZ)\"}" || echo "000 0") || true
  read -r c t <<<"$out"; echo "$(date +%s) $id $c $t" >> "$tmp/res"; [ "$c" = 202 ] && echo "$id" >> "$tmp/accepted"
  sleep 0.5
done
[ -n "$CMD" ] && wait "$CP" || true
[ -n "$CMD" ] && sed 's/^/    cmd: /' "$tmp/cmd.out" | tail -15
total=$(wc -l < "$tmp/res"); ok=$(wc -l < "$tmp/accepted"); echo "writes: $total sent, $ok answered 202"
awk '$3!=202 {print "  not 202: "$0}' "$tmp/res" | head -20
awk '$3==202 && $4>1 {n++} END{print "  202 answers slower than 1 s: " n+0}' "$tmp/res"
awk '$3==202 {print $4}' "$tmp/res" | sort -n | awk '{a[NR]=$1} END{if(NR) printf "  202 latency p50 %.2f s, p95 %.2f s, max %.2f s\n", a[int(NR*0.5)+1], a[int(NR*0.95)+1], a[NR]}'
echo ">>> waiting up to 3 min for the reports to reach the store"
for _ in $(seq 1 18); do
  cursor=""; : > "$tmp/stored"
  while :; do body=$(audit "/internal/audit/events?source=FIELD_REPORT&limit=1000${cursor:+&cursor=$cursor}" 2>/dev/null) || break; jq -r '.items[].source_ref_id' <<<"$body" >> "$tmp/stored"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
  lost=$({ grep -vxFf "$tmp/stored" "$tmp/accepted" || true; } | wc -l | tr -d ' '); [ "$lost" = 0 ] && break; sleep 10
done
dups=$({ grep "^WP-$run-" "$tmp/stored" || true; } | sort | uniq -d | wc -l | tr -d ' ')
[ "$lost" = 0 ] && pass "all $ok reports answered 202 are in the store" || fail "$lost of $ok accepted reports are missing from the store"
[ "$dups" = 0 ] && pass "no report stored twice" || fail "$dups reports stored twice"
[ "$ok" = "$total" ] && pass "every write was accepted (no refusal or timeout during the window)" || fail "$((total - ok)) of $total writes were not answered 202"
finish
