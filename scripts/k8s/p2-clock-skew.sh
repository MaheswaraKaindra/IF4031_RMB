#!/usr/bin/env bash
# P2 criterion 4: the clock of the node that is fetching drifts (+45 s, then -30 s). Show that two instances are never both valid
# leaders for the same source and that the store never gets a duplicate from the overlap.
#   SSH_USER=<vm user> scripts/k8s/p2-clock-skew.sh        (passwordless sudo on the VMs; NTP is switched off during the test)
# Samples /health of every aggregator pod every 2 s during the whole test and always restores NTP on exit.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
HOLD=${HOLD_S:-60}; LEASES=${LEASES:-aggregator-poller-bmkg}
tmp=$(mktemp -d); VICTIM=""; SKEWED=0; FOLLOWER=""; FSKEWED=0
restore() {
  stop_leader_sampler
  if [ "$SKEWED" = 1 ] && [ -n "$VICTIM" ]; then
    echo ">>> restoring NTP on $VICTIM"
    node_ssh "$VICTIM" 'sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd 2>/dev/null || sudo systemctl restart chrony 2>/dev/null || true' || echo "WARN: could not restore NTP on $VICTIM: run 'sudo timedatectl set-ntp true' there"
  fi
  if [ "$FSKEWED" = 1 ] && [ -n "$FOLLOWER" ]; then
    node_ssh "$FOLLOWER" 'sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd 2>/dev/null || sudo systemctl restart chrony 2>/dev/null || true' || echo "WARN: could not restore NTP on $FOLLOWER"
  fi
  cleanup_pf; rm -rf "$tmp"
}
trap restore EXIT

lease=${LEASES%% *}; leader=$(lease_holder "$lease"); VICTIM=$(pod_node "$leader")
echo "leader of $lease: $leader on $VICTIM (its node's clock will be shifted)"
node_ssh "$VICTIM" 'date -u +%T' >/dev/null || { echo "cannot SSH to $VICTIM (set SSH_USER)" >&2; exit 1; }
trans0=$(lease_transitions "$lease")
SOURCE=${lease##*-}; SOURCE=${SOURCE^^}

start_leader_sampler "$SOURCE" "$tmp/leaders"
T0_ISO=$(date -u +%FT%TZ)

skew() { # skew <seconds relative to real time>
  node_ssh "$VICTIM" "sudo timedatectl set-ntp false; sudo date -u -s @\$(( \$(date +%s) + ($1) ))" >/dev/null
  SKEWED=1
}
echo ">>> clock +45 s for ${HOLD}s"; skew 45; sleep "$HOLD"
echo ">>> clock -30 s (relative to real time) for ${HOLD}s"
node_ssh "$VICTIM" "sudo date -u -s @\$(( \$(date +%s) - 45 - 30 ))" >/dev/null; sleep "$HOLD"
echo ">>> clock restored"; node_ssh "$VICTIM" 'sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd 2>/dev/null || sudo systemctl restart chrony 2>/dev/null || true'; SKEWED=0
sleep 40
trans_leader=$(( $(lease_transitions "$lease") - trans0 ))
# second phase: the clock of a node that is NOT leading drifts +45 s; the leader must not notice or change
FOLLOWER=$(kubectl get nodes -o json | jq -r --arg v "$VICTIM" '[.items[] | select(.metadata.name != $v) | .metadata.name][0]')
echo ">>> clock +45 s on $FOLLOWER (not the leader of $lease) for ${HOLD}s"
cur=$(lease_holder "$lease"); trans1=$(lease_transitions "$lease")
node_ssh "$FOLLOWER" "sudo timedatectl set-ntp false; sudo date -u -s @\$(( \$(date +%s) + 45 ))" >/dev/null; FSKEWED=1; sleep "$HOLD"
node_ssh "$FOLLOWER" 'sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd 2>/dev/null || sudo systemctl restart chrony 2>/dev/null || true'; FSKEWED=0
sleep 20
stop_leader_sampler
[ "$(( $(lease_transitions "$lease") - trans1 ))" -le 1 ] && pass "a drifting FOLLOWER clock caused at most one leadership change ($(( $(lease_transitions "$lease") - trans1 )))" || fail "a drifting follower clock caused $(( $(lease_transitions "$lease") - trans1 )) leadership changes"

assert_single_leader "$tmp/leaders" 30 "clock changes on $SOURCE"
trans=$(( $(lease_transitions "$lease") - trans0 )); echo "leadership changes during the test: $trans"

# the upstream sees one caller at a time: count alternations between callers and compare with leadership changes
mock=mock-${SOURCE,,}
seq=$(kubectl -n "$NS" logs "deploy/$mock" --since-time="$T0_ISO" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .caller_pod' | uniq)
alt=$(( $(printf '%s\n' "$seq" | grep -c .) - 1 )); [ "$alt" -lt 0 ] && alt=0
[ "$alt" -le "$trans" ] && pass "upstream saw $alt caller change(s) for $trans leadership change(s): no interleaved callers" || fail "upstream saw $alt caller changes for only $trans leadership changes (interleaving = two active fetchers)"

cursor=""; : > "$tmp/all"
while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || { fail "Audit API did not answer"; break; }
  jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && pass "no duplicate HazardEvent after the clock changes" || fail "$dups duplicate HazardEvent(s)"
# gap check: every event the BMKG mock produced must be stored. A poller whose clock ran ahead used to write a cursor in the future and skip events.
kubectl -n "$NS" port-forward svc/mock-bmkg 18081:8081 >/dev/null 2>&1 & mpf=$!; sleep 3
curl -s -m 10 -H "X-BMKG-Key: $(envget X_BMKG_KEY)" localhost:18081/seismic-events | jq -r '.[].event_id' | sed 's/^/BMKG|/' | LC_ALL=C sort -u > "$tmp/mock"
kill "$mpf" 2>/dev/null; wait "$mpf" 2>/dev/null || true
LC_ALL=C sort -u "$tmp/all" > "$tmp/after"; missing=$(LC_ALL=C comm -23 "$tmp/mock" "$tmp/after" | wc -l | tr -d ' ')
[ "$(wc -l < "$tmp/mock" | tr -d ' ')" -gt 0 ] || fail "the mock reported no events: the gap check had no data"
[ "$missing" = 0 ] && pass "every event the BMKG mock produced ($(wc -l < "$tmp/mock" | tr -d ' ')) is stored: no gap under clock shifts" || fail "$missing mock event(s) never reached the store (a clock shift caused a data gap)"
stale=$(for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}'); do kubectl -n "$NS" logs "$p" -c aggregator --since-time="$T0_ISO" 2>/dev/null | grep -c 'stale_epoch\|stale epoch\|fenced' || true; done | paste -sd+ | bc)
echo "fenced/stale-epoch rejections logged: ${stale:-0}"
[ "$trans_leader" -le 4 ] && pass "the drifting leader clock caused $trans_leader leadership change(s) (before the monotonic-clock fix it caused 10 in 3 minutes)" || fail "the drifting leader clock caused $trans_leader leadership changes"
finish
