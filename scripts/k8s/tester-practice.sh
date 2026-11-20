#!/usr/bin/env bash
# Run one official Tester Agent PRACTICE scenario and judge the outcome, whichever node it disturbs.
#   scripts/k8s/tester-practice.sh <scenario>        names: kubectl exec -n tester-agent daemonset/tester-agent -- /app list
# Before: waits for full redundancy and saves every stored record id. During: probes the Audit API, client-api and auth through ALL
# node NodePorts (an answer from any node counts), logs the agent's steps. After: waits for the cluster to recover on its own and
# checks that nothing was lost or duplicated and that every pod is Ready again.
set -uo pipefail
source "$(dirname "$0")/assert-lib.sh"
SC=${1:?scenario name (see /app list)}; MAXWAIT=${MAXWAIT_S:-900}
tmp=$(mktemp -d); trap 'cleanup_pf; kill ${PROBE:-} 2>/dev/null; rm -rf "$tmp"' EXIT
IPS=$(kubectl get nodes -o json | jq -r '.items[].status.addresses[] | select(.type=="InternalIP") | .address' | tr '\n' ' ')
kc() { local s; kubectl "$@" 2>/dev/null && return 0; for s in $IPS; do kubectl --server "https://$s:6443" "$@" 2>/dev/null && return 0; done; return 1; }
export TOL=20
for _ in $(seq 1 60); do redundancy_ok && break; sleep 5; done
redundancy_ok || { echo "FAIL: redundancy not restored before the run" >&2; exit 1; }
collect_ids "$tmp/before"; echo "records before: $(wc -l < "$tmp/before" | tr -d ' ')"

probe() { # one line per second: <epoch> <audit ok/fail> <api ...> <auth ...>, each tried through every node
  local AT SEC; AT=$AUDIT_TOKEN; SEC=$(envget AUTH_CLIENT_FIELD_TEAM_SECRET)
  while :; do
    t=$(date +%s); a=fail; r=fail; u=fail
    for ip in $IPS; do
      [ $a = fail ] && [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AT" "http://$ip:30000/internal/audit/checksum?source=BMKG")" = 200 ] && a=ok
      if [ $u = fail ]; then tok=$(curl -s -m 3 -X POST "http://$ip:30090/token" -H 'content-type: application/json' -d "{\"client_id\":\"field-team\",\"client_secret\":\"$SEC\"}" | jq -r '.access_token // empty'); [ -n "$tok" ] && u=ok; fi
      [ $r = fail ] && [ -n "${tok:-}" ] && [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $tok" "http://$ip:30080/events?limit=5")" = 200 ] && r=ok
      [ $a = ok ] && [ $r = ok ] && [ $u = ok ] && break
    done
    echo "$t $a $r $u"; sleep 1
  done
}
probe > "$tmp/probe.log" 2>/dev/null & PROBE=$!

T0=$(date -u +%FT%TZ); echo ">>> running scenario '$SC' at $T0"
kubectl exec -n tester-agent daemonset/tester-agent -- /app run practice "$SC" 2>&1 | tail -4 | cut -c1-160
done_at=""; for i in $(seq 1 "$MAXWAIT"); do
  kc logs -n tester-agent -l app=tester-agent --prefix=false --since-time="$T0" 2>/dev/null | jq -r '.action? // empty' 2>/dev/null | grep -q "pemulihan akhir selesai" && { done_at=$i; break; }; sleep 1; done
echo ">>> agent steps:"; kc logs -n tester-agent -l app=tester-agent --prefix=false --since-time="$T0" 2>/dev/null | jq -r 'select(.action != null) | "    \(.ts[11:19]) \(.action[0:150])"' 2>/dev/null | head -20
[ -n "$done_at" ] && pass "the agent finished the scenario and its own recovery after ~${done_at}s" || fail "the agent did not report completion within ${MAXWAIT}s"

echo ">>> waiting for the system to recover by itself (up to ${MAXWAIT}s)"
rec=""; for i in $(seq 1 "$MAXWAIT"); do
  n=$(kc get nodes --no-headers | awk '$2!="Ready"{c++} END{print c+0}'); p=$(kc -n "$NS" get pods --no-headers | awk '{split($2,a,"/"); if (a[1]!=a[2] && $3!="Completed") c++} END{print c+0}')
  [ "$n" = 0 ] && [ "$p" = 0 ] && redundancy_ok && { rec=$i; break; }; sleep 5; i=$((i+4))
done
[ -n "$rec" ] && pass "nodes, pods and shard redundancy are back without intervention (~${rec}s)" || fail "the system did not recover within ${MAXWAIT}s (not-ready nodes=$n, pods=$p)"
sleep 5; kill "$PROBE" 2>/dev/null; PROBE=""
for col in 2:"Audit API" 3:"client-api /events" 4:"auth /token"; do c=${col%%:*}; name=${col#*:}
  bad=$(awk -v c="$c" '$c=="fail"{n++} END{print n+0}' "$tmp/probe.log"); tot=$(wc -l < "$tmp/probe.log" | tr -d ' ')
  echo "     $name: no node answered in $bad of $tot probes (1 per second)"
done
collect_ids "$tmp/after" || fail "could not list the records after the run"
lost=$(LC_ALL=C comm -23 "$tmp/before" "$tmp/after" | wc -l | tr -d ' ')
[ "$lost" = 0 ] && pass "no record lost ($(wc -l < "$tmp/before" | tr -d ' ') before, $(wc -l < "$tmp/after" | tr -d ' ') after)" || fail "$lost record(s) lost"
cursor=""; : > "$tmp/all"; while :; do body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || break; jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$tmp/all"; cursor=$(jq -r '.next_cursor // empty' <<<"$body"); [ -z "$cursor" ] && break; done
dups=$(LC_ALL=C sort "$tmp/all" | uniq -d | wc -l | tr -d ' '); [ "$dups" = 0 ] && pass "no duplicate HazardEvent" || fail "$dups duplicate(s)"
finish
