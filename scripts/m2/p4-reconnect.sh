#!/usr/bin/env bash
# P4 criterion 8 on the real feed: the connection to the feed is cut while the leader is processing (no pod restart, no lease change), comes back, and the
# stream resumes from the exact position: the feed log has no gap and no duplicate, and the committed offset only moves forward.
#   scripts/m2/p4-reconnect.sh     [CUT_S=20]
# The cut: on the leader's node, packets from the leader pod to the feed host are rejected with a TCP reset for CUT_S seconds (an established connection is
# reset, new connections are refused), then the rule is removed (also on any exit). Needs SSH to the nodes (SSH_USER) and passwordless sudo.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
ROOT=$(cd "$(dirname "$0")/../.." && pwd); CUT=${CUT_S:-20}; PF=""; RULE_NODE=""; RULE_IP=""; FEED_IP=""
undo() { [ -n "$PF" ] && kill "$PF" 2>/dev/null || true; [ -n "$RULE_NODE" ] && node_ssh "$RULE_NODE" "sudo iptables -D FORWARD -s $RULE_IP -d $FEED_IP -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null; sudo iptables -D INPUT -s $RULE_IP -d $FEED_IP -p tcp -j REJECT --reject-with tcp-reset 2>/dev/null; true" >/dev/null 2>&1 || true; }
trap undo EXIT
metric() { kubectl -n "$NS" exec "$1" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null | awk -v n="$2" '!f && $1==n {print $2; f=1}'; }
L=$(lease_holder aggregator-satellite); [ -n "$L" ] || { fail "nobody holds the aggregator-satellite lease"; finish; }
lnode=$(pod_node "$L"); pip=$(kubectl -n "$NS" get pod "$L" -o jsonpath='{.status.podIP}')
FEED_IP=$(getent ahostsv4 satellite.naufarrel.dev | awk '{print $1}' | sort -u | paste -sd, -); [ -n "$FEED_IP" ] || { fail "cannot resolve the feed host"; finish; }
restarts0=$(kubectl -n "$NS" get pod "$L" -o jsonpath='{.status.containerStatuses[0].restartCount}'); epoch0=$(kubectl -n "$NS" get lease aggregator-satellite -o jsonpath='{.spec.leaseTransitions}')
c0=$(metric "$L" satellite_committed_offset); echo "leader $L on $lnode (pod IP $pip), feed host $FEED_IP, committed offset before the cut: $c0"
RULE_NODE=$lnode; RULE_IP=$pip
T0=$(date +%s)
node_ssh "$lnode" "sudo iptables -I FORWARD 1 -s $pip -d $FEED_IP -p tcp -j REJECT --reject-with tcp-reset; sudo iptables -I INPUT 1 -s $pip -d $FEED_IP -p tcp -j REJECT --reject-with tcp-reset"
echo ">>> feed connection cut at $(date -u +%T)"; sleep "$CUT"
c_mid=$(metric "$L" satellite_committed_offset); lat_mid=$(metric "$L" satellite_source_latest_offset)
undo; RULE_NODE=""; echo ">>> connection allowed again at $(date -u +%T); during the cut the committed offset was $c_mid"
for i in $(seq 1 60); do c=$(metric "$L" satellite_committed_offset); l=$(metric "$L" satellite_source_latest_offset); [ -n "$c" ] && [ -n "$l" ] && [ $((l - c)) -le 200 ] && break; sleep 2; done
T1=$(date +%s); c1=$(metric "$L" satellite_committed_offset)
[ -n "${c:-}" ] && [ $((l - c)) -le 200 ] && pass "caught up with the feed $((T1 - T0)) s after the cut began (lag $((l - c)) frames)" || fail "not caught up 2 minutes after the cut"
[ "$(kubectl -n "$NS" get pod "$L" -o jsonpath='{.status.containerStatuses[0].restartCount}')" = "$restarts0" ] && [ "$(kubectl -n "$NS" get lease aggregator-satellite -o jsonpath='{.spec.leaseTransitions}')" = "$epoch0" ] && pass "same pod, no restart, no change of leader: only the connection was lost" || fail "the pod restarted or the leadership changed, so this was not a pure reconnect"
[ "$c1" -ge "$c0" ] && pass "committed offset moved forward only ($c0 -> $c1)" || fail "committed offset went backwards ($c0 -> $c1)"
export MONGO_URI="mongodb://aggregator:$(envget MONGO_APP_PASSWORD)@127.0.0.1:27018/?authSource=admin"
MP=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=mongos -o jsonpath='{.items[0].metadata.name}'); kubectl -n "$NS" port-forward "pod/$MP" 27018:27017 >/dev/null 2>&1 & PF=$!; sleep 3
read -r count min max < <(cd "$ROOT/aggregator" && node --input-type=module -e "
import {MongoClient} from 'mongodb';
const c = new MongoClient(process.env.MONGO_URI); await c.connect();
const k = c.db('bnpb_canonical_store').collection('satellite_feed_log');
const max = (await k.find({}, {projection:{_id:1}}).sort({_id:-1}).limit(1).next())._id;
const min = (await k.find({}, {projection:{_id:1}}).sort({_id:1}).limit(1).next())._id;
const count = await k.countDocuments({_id: {\$lte: max}});
console.log(count, min, max); await c.close();")
echo "frames stored: $count, lowest offset $min, highest $max"
[ "$min" = 0 ] && [ "$count" = $(( max + 1 )) ] && pass "feed log contiguous after the reconnect: $count frames for offsets 0..$max, none lost, none stored twice" || fail "gap or duplicate in the feed log ($count frames for offsets $min..$max)"
echo "log lines about the stream during the test:"; kubectl -n "$NS" logs "$L" -c aggregator --since-time="$(date -u -d @"$T0" +%FT%TZ)" 2>/dev/null | grep -E "satellite (stream|session)" | cut -c1-260 | head -8
finish
