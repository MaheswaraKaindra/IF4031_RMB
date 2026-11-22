#!/usr/bin/env bash
# P4 on the REAL satellite feed (needs SATELLITE_GROUP_TOKEN in the aggregator secret, see create-secrets.sh):
#   - the pipeline is running and caught up with the feed (offset lag small), with fires in the store and an ingest-to-store p95
#   - the leader is killed mid-stream (SCENARIO=kill-leader: SIGKILL of the Node process from its node over SSH, no lease release; SCENARIO=node-loss: the leader's node is
#     powered off, needs VM_STOP_CMD / VM_START_CMD): a new leader takes over, processing resumes from the durable checkpoint, the feed log has no gap
#     and no duplicate, the epoch moved forward and the pipeline is caught up again
#   SCENARIO=baseline|kill-leader|node-loss  [TAKEOVER_MAX_S=60 CATCHUP_MAX_S=120]  scripts/m2/p4-checks.sh
# The record-level comparison with an independent recomputation is separate (aggregator/src/tools/satellite-tool.ts reference, takes minutes).
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SCENARIO=${SCENARIO:-kill-leader}; TAKEOVER_MAX=${TAKEOVER_MAX_S:-60}; CATCHUP_MAX=${CATCHUP_MAX_S:-120}
PFS=(); STOPPED_NODE=""
restore() {
  for p in "${PFS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
  [ -n "$STOPPED_NODE" ] && { echo ">>> starting $STOPPED_NODE again"; vm_do start "$STOPPED_NODE" || true; node_ready_wait "$STOPPED_NODE" 300 || true; }
  return 0   # without this the failed test above (no node was stopped) made the script exit 1 although every check passed
}
trap restore EXIT

metric() { # metric <pod> <name> -> value of an unlabelled gauge, empty if the pod does not answer
  kubectl -n "$NS" exec "$1" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null | awk -v n="$2" '!f && $1==n {print $2; f=1}'
}
buckets() { # buckets <pod>: "le count" lines of satellite_ingest_to_store_seconds
  kubectl -n "$NS" exec "$1" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null | awk '/^satellite_ingest_to_store_seconds_bucket/ { match($0,/le="[^"]+"/); print substr($0,RSTART+4,RLENGTH-5), $NF }'
}
p95_window() { # p95_window <pod> <seconds>: upper bound (s) of the bucket holding the 95th percentile of the frames stored during the window
  local a b; a=$(buckets "$1"); sleep "$2"; b=$(buckets "$1")
  paste <(printf '%s\n' "$a") <(printf '%s\n' "$b") | awk '
    { le[NR]=$1; d[NR]=$4-$2 }
    END { if (NR==0 || d[NR] <= 0) { print "no frames in the window"; exit }
          for (i=1;i<=NR;i++) if (d[i] >= 0.95*d[NR]) { print "<= " le[i] " s (" d[NR] " frames)"; exit } }'
}
caught_up() { # caught_up <pod> <max-lag>
  local c l; c=$(metric "$1" satellite_committed_offset); l=$(metric "$1" satellite_source_latest_offset)
  [ -n "$c" ] && [ -n "$l" ] && [ $(( l - c )) -le "$2" ]
}
leader_pod() { lease_holder aggregator-satellite; }

echo ">>> baseline: is the pipeline running and caught up?"
L=$(leader_pod); [ -n "$L" ] || { fail "nobody holds the aggregator-satellite lease: is SATELLITE_GROUP_TOKEN set in aggregator-secret?"; finish; }
lnode=$(pod_node "$L"); epoch0=$(metric "$L" 'aggregator_leader_epoch{source="SATELIT"}'); [ -n "$epoch0" ] || epoch0=$(kubectl -n "$NS" get lease aggregator-satellite -o jsonpath='{.spec.leaseTransitions}')
c0=$(metric "$L" satellite_committed_offset); lat0=$(metric "$L" satellite_source_latest_offset)
echo "     leader $L on $lnode, committed offset $c0, feed latest $lat0"
check "the pipeline is caught up with the feed (lag <= 200 frames)" caught_up "$L" 200
fires=$(metric "$L" satellite_active_fires); [ "${fires:-0}" -gt 0 ] && pass "$fires active fires in the store's working set" || fail "no active fires"
echo "     ingest-to-store p95 over a 45 s window: $(p95_window "$L" 45)"
[ "$SCENARIO" = baseline ] && { finish; exit 0; }

echo ">>> scenario: $SCENARIO"
case $SCENARIO in
  kill-leader) T0=$(date +%s); crash_pod_process "$L" "$lnode" >/dev/null 2>&1 || true ;;
  node-loss) use_survivor "$lnode"; T0=$(date +%s); vm_do stop "$lnode"; STOPPED_NODE=$lnode ;;
  *) echo "unknown SCENARIO $SCENARIO" >&2; exit 2 ;;
esac
# Recovered = some pod (a different one, or the same pod after its container restarted) holds the lease under a HIGHER epoch and is processing.
new=""; for i in $(seq 1 $((TAKEOVER_MAX * 2))); do h=$(leader_pod 2>/dev/null || true)
  if [ -n "$h" ]; then e=$(metric "$h" 'aggregator_leader_epoch{source="SATELIT"}' || true); c=$(metric "$h" satellite_committed_offset || true)
    [ -n "$e" ] && [ -n "$c" ] && [ "$e" -gt "${epoch0:-0}" ] && { new=$h; break; }; fi; sleep 0.5; done
T1=$(date +%s)
[ -n "$new" ] && pass "$SCENARIO: $new leads again under a higher epoch and is processing after $((T1 - T0)) s (limit ${TAKEOVER_MAX} s)$([ "$new" = "$L" ] && echo " [the same pod, after its container restarted]")" || { fail "$SCENARIO: no new leader processing within ${TAKEOVER_MAX} s"; finish; }
# The outage is a burst of its own: the feed runs at 60x, so everything it sent while nobody processed is a backlog (criterion 4: up to date within 60 s after the surge ends = after the new leader started).
wait_for "$CATCHUP_MAX" caught_up "$new" 200 && pass "caught up with the feed again $(( $(date +%s) - T0 )) s after the failure, $(( $(date +%s) - T1 )) s after the new leader started processing (limit ${CATCHUP_MAX} s)" || fail "not caught up ${CATCHUP_MAX} s after the failure"
c1=$(metric "$new" satellite_committed_offset); [ "$c1" -ge "$c0" ] && pass "committed offset moved forward only ($c0 -> $c1): processing resumed from the checkpoint, nothing re-applied below it" || fail "committed offset went backwards ($c0 -> $c1)"
epoch1=$(metric "$new" 'aggregator_leader_epoch{source="SATELIT"}'); [ -n "$epoch1" ] && [ "$epoch1" -gt "${epoch0:-0}" ] && pass "the fencing epoch increased ($epoch0 -> $epoch1)" || fail "the fencing epoch did not increase ($epoch0 -> $epoch1)"

echo ">>> feed log contiguity (no gap, no duplicate) in the store"
export MONGO_URI="mongodb://aggregator:$(grep -E '^MONGO_APP_PASSWORD=' "$ROOT/.env" | tail -n1 | cut -d= -f2-)@127.0.0.1:27018/?authSource=admin"
kubectl -n "$NS" port-forward svc/mongos 27018:27017 >/dev/null 2>&1 & PFS+=($!)
sleep 3
read -r count min max < <(cd "$ROOT/aggregator" && node --input-type=module -e "
import {MongoClient} from 'mongodb';
const c = new MongoClient(process.env.MONGO_URI); await c.connect();
const k = c.db('bnpb_canonical_store').collection('satellite_feed_log');
const max = (await k.find({}, {projection:{_id:1}}).sort({_id:-1}).limit(1).next())._id;
const min = (await k.find({}, {projection:{_id:1}}).sort({_id:1}).limit(1).next())._id;
const count = await k.countDocuments({_id: {\$lte: max}}); // fixed upper bound: the feed keeps writing while we count
console.log(count, min, max); await c.close();")
echo "     frames stored: $count, lowest offset $min, highest $max"
[ "$min" = 0 ] && [ "$count" = $(( max + 1 )) ] && pass "the feed log is contiguous: $count frames for offsets 0..$max, so none lost and none stored twice" || fail "the feed log has a gap or a duplicate ($count frames for offsets $min..$max)"
finish
