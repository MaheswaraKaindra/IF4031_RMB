#!/usr/bin/env bash
# P1 criterion 4, timed: probe the Audit API, analytics and the client API once per second THROUGH THE NODEPORTS of a surviving node while one node is
# powered off for real, and print every probe with its time since the power-off, HTTP code and latency. Shows exactly which requests fail and for how long.
#   VICTIM=node-d SURVIVOR_IP=192.168.56.11 VM_STOP_CMD=... VM_START_CMD=... [WINDOW=120] scripts/m2/p1-probe-loss.sh
set -uo pipefail
source "$(dirname "$0")/p1-lib.sh"
source "$(dirname "$0")/assert-lib.sh"
VICTIM=${VICTIM:?node to power off}; NODE_IP=${SURVIVOR_IP:?ip of a node that stays up}; WINDOW=${WINDOW:-120}
AUDIT_URL=http://$NODE_IP:30000; AUTH_URL=http://$NODE_IP:30090; API_URL=http://$NODE_IP:30080
T0=$(date +%s.%N); off=""
probe() { # name path
  local s e code
  s=$(date +%s.%N); code=$(curl -s -m ${PROBE_TIMEOUT:-15} -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUDIT_TOKEN" "$AUDIT_URL$2"); e=$(date +%s.%N)
  printf '%.1f %-10s %s %5.2fs\n' "$s" "$1" "$code" "$(echo "$e - $s" | bc)"
}
( for _ in $(seq 1 $((WINDOW / 1))); do
    probe events "/internal/audit/events?limit=50" &
    probe checksum "/internal/audit/checksum" &
    probe analytics "/internal/analytics/summary" &
    read -r c t p <<<"$(client_events)"; printf '%.1f %-10s %s %5.2fs %s\n' "$(date +%s.%N)" client "$c" "$t" "$p"
    wait; sleep 1
  done ) > "${OUT:-/tmp/p1-probe-loss.txt}" 2>&1 &
PROBE=$!
sleep 10; off=$(date +%s.%N); echo ">>> powering off $VICTIM at $(date -u +%T)"; date +%s.%N > "${OUT:-/tmp/p1-probe-loss.txt}.off"
vm_do stop "$VICTIM"
wait $PROBE
# convert absolute times into seconds since the power-off
OUTF=${OUT:-/tmp/p1-probe-loss.txt}; O=$(cat "$OUTF.off")
awk -v o="$O" '{ $1=sprintf("%+6.1fs",$1-o); print }' "$OUTF" | sort -t' ' -k1.1,1.7 -n > "$OUTF.rel"
echo "failures (code != 200 or slow > 2 s):"; awk '$3!="200" || $4+0>2' "$OUTF.rel" | head -60
echo "totals: $(grep -c ' 200 ' "$OUTF.rel") ok of $(wc -l < "$OUTF.rel") probes"
echo ">>> starting $VICTIM again"; vm_do start "$VICTIM"; node_ready_wait "$VICTIM" 400 || echo "node did not return"
