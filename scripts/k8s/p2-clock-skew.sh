#!/usr/bin/env bash
# P2 criterion 4: the clock of the node that is fetching drifts (+45 s, then -30 s). Show that two instances are never both valid
# leaders for the same source and that the store never gets a duplicate from the overlap.
#   SSH_USER=<vm user> scripts/k8s/p2-clock-skew.sh        (passwordless sudo on the VMs; NTP is switched off during the test)
# Samples /health of every aggregator pod every 2 s during the whole test and always restores NTP on exit.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
HOLD=${HOLD_S:-60}; LEASES=${LEASES:-aggregator-poller-bmkg}
tmp=$(mktemp -d); VICTIM=""; SKEWED=0; SAMPLER=""
restore() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null || true
  if [ "$SKEWED" = 1 ] && [ -n "$VICTIM" ]; then
    echo ">>> restoring NTP on $VICTIM"
    node_ssh "$VICTIM" 'sudo timedatectl set-ntp true; sudo systemctl restart systemd-timesyncd 2>/dev/null || sudo systemctl restart chrony 2>/dev/null || true' || echo "WARN: could not restore NTP on $VICTIM: run 'sudo timedatectl set-ntp true' there"
  fi
  cleanup_pf; rm -rf "$tmp"
}
trap restore EXIT

lease=${LEASES%% *}; leader=$(lease_holder "$lease"); VICTIM=$(pod_node "$leader")
echo "leader of $lease: $leader on $VICTIM (its node's clock will be shifted)"
node_ssh "$VICTIM" 'date -u +%T' >/dev/null || { echo "cannot SSH to $VICTIM (set SSH_USER)" >&2; exit 1; }
trans0=$(lease_transitions "$lease")
SOURCE=${lease##*-}; SOURCE=${SOURCE^^}

sample() { # every 2 s: for each aggregator pod, is it a VALID leader of this source?
  while :; do
    ts=$(date +%s)
    for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}'); do
      v=$(kubectl -n "$NS" exec "$p" -c aggregator -- wget -qO- -T 2 http://127.0.0.1:3000/health 2>/dev/null | jq -r --arg s "$SOURCE" '.leadership[$s] | select(.isLeader==true and .valid==true) | "1"' 2>/dev/null || true)
      [ "$v" = 1 ] && echo "$ts $p"
    done
    sleep 2
  done
}
sample > "$tmp/leaders" 2>/dev/null & SAMPLER=$!
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
kill "$SAMPLER" 2>/dev/null || true; SAMPLER=""

# at no sampled instant are two different pods valid leaders of the same source
overlap=$(awk '{c[$1]++; if(!($1 in p)||p[$1]!=$2){if($1 in p && p[$1]!=$2) o[$1]=1; p[$1]=$2}} END{n=0; for(k in o)n++; print n}' "$tmp/leaders")
samples=$(awk '{print $1}' "$tmp/leaders" | sort -u | wc -l | tr -d ' ')
echo "samples with a valid leader: $samples, distinct leader pods seen: $(awk '{print $2}' "$tmp/leaders" | sort -u | wc -l | tr -d ' ')"
[ "$overlap" = 0 ] && pass "never two valid leaders of $SOURCE in the same sample" || fail "$overlap sample(s) with two valid leaders of $SOURCE"
trans=$(( $(lease_transitions "$lease") - trans0 )); echo "leadership changes during the test: $trans"

# the upstream sees one caller at a time: count alternations between callers and compare with leadership changes
mock=mock-${SOURCE,,}
seq=$(kubectl -n "$NS" logs "deploy/$mock" --since-time="$T0_ISO" 2>/dev/null | jq -r 'select(.msg=="upstream poll served") | .caller_pod' | uniq)
alt=$(( $(printf '%s\n' "$seq" | grep -c .) - 1 )); [ "$alt" -lt 0 ] && alt=0
[ "$alt" -le $(( trans + 1 )) ] && pass "upstream saw $alt caller change(s) for $trans leadership change(s): no interleaved callers" || fail "upstream saw $alt caller changes for only $trans leadership changes (interleaving = two active fetchers)"

cursor=""; : > "$tmp/all"
while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || { fail "Audit API did not answer"; break; }
  jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' ')
[ "$dups" = 0 ] && pass "no duplicate HazardEvent after the clock changes" || fail "$dups duplicate HazardEvent(s)"
stale=$(for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}'); do kubectl -n "$NS" logs "$p" -c aggregator --since-time="$T0_ISO" 2>/dev/null | grep -c 'stale_epoch\|stale epoch\|fenced' || true; done | paste -sd+ | bc)
echo "fenced/stale-epoch rejections logged: ${stale:-0} (informational)"
finish
