#!/usr/bin/env bash
# P1 criterion 5 with a DIFFERENT machine: move a store slot from a lost node to a replacement node with an empty disk.
#   [IDS_BEFORE=<pre-loss id list>] scripts/k8s/p1-replace-node.sh <slot 1|2|3> <new-node> [--delete-old-node]
# Use after a node is gone for good (VM destroyed). The new node must already be joined to the cluster and must not hold
# another slot (two slots on one node would put a whole shard on one machine). What it does:
#   1. moves the label bnpb.io/store-slot=<slot> to <new-node>
#   2. for every store member of the slot: stop it, force-remove the pod left on the dead node, delete its PVC (the local
#      volume lived on the dead node and can never be mounted elsewhere), start it again -> new empty volume on <new-node>
#   3. republishes the placement map (store-topology) with the new node name
#   4. waits until every shard has two caught-up data copies again, then verifies no record was lost
# Pods of other workloads on the dead node are rescheduled by Kubernetes itself (after the eviction toleration: 20s in the
# demo overlay, 5 min by default); --delete-old-node removes the Node object so that happens immediately.
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
SLOT=${1:?slot 1|2|3}; NEW=${2:?new node name (kubectl get nodes)}; DELETE_OLD=${3:-}
LABEL=bnpb.io/store-slot

kubectl get node "$NEW" >/dev/null
holder=$(kubectl get nodes -l "$LABEL" -o jsonpath="{range .items[*]}{.metadata.name}={.metadata.labels['bnpb\.io/store-slot']}{'\n'}{end}")
other=$(printf '%s\n' "$holder" | awk -F= -v n="$NEW" -v s="$SLOT" '$1 == n && $2 != s {print $2}')
[ -z "$other" ] || { echo "FAIL: $NEW already holds slot $other; pick a node without a slot" >&2; exit 1; }
OLD=$(printf '%s\n' "$holder" | awk -F= -v s="$SLOT" '$2 == s {print $1}' | head -n1)
members=$(members_of_slot "$SLOT")
[ -n "$members" ] || { echo "no members for slot $SLOT" >&2; exit 1; }
echo "slot $SLOT: ${OLD:-<no node>} -> $NEW   members: $(echo $members | tr '\n' ' ')"

SNAP=$(mktemp -d); trap 'cleanup_pf; rm -rf "$SNAP"' EXIT
start_forward
# Reference list: IDS_BEFORE (saved by p1-node-loss.sh BEFORE the node died = the real pre-loss state), otherwise the
# records readable now from the surviving copies (every shard keeps one data member on the other two slots).
if [ -n "${IDS_BEFORE:-}" ]; then
  LC_ALL=C sort -u "$IDS_BEFORE" > "$SNAP/ids-before"; echo "reference: pre-loss list $IDS_BEFORE"
else
  collect_ids "$SNAP/ids-before" || { echo "FAIL: could not read the pre-replacement record list" >&2; exit 1; }
  echo "reference: records readable now (pass IDS_BEFORE=<file from p1-node-loss.sh> for the pre-loss list)"
fi
echo "records before: $(wc -l < "$SNAP/ids-before" | tr -d ' ')"

[ -n "$OLD" ] && [ "$OLD" != "$NEW" ] && kubectl label node "$OLD" "$LABEL-" >/dev/null 2>&1 || true
kubectl label node "$NEW" "$LABEL=$SLOT" --overwrite >/dev/null
# Placement map for /internal/audit/location and the report: the aggregator reloads it (~1 min, no restart).
"$ROOT/scripts/k8s/store-topology.sh" | tail -n1
if [ "$DELETE_OLD" = "--delete-old-node" ] && [ -n "$OLD" ] && [ "$OLD" != "$NEW" ]; then kubectl delete node "$OLD" --wait=false; fi

for m in $members; do
  kubectl -n "$NS" scale statefulset "$m" --replicas=0 >/dev/null
  # A pod on a dead node never confirms its own termination: remove it without waiting for the kubelet.
  kubectl -n "$NS" delete pod "$m-0" --grace-period=0 --force >/dev/null 2>&1 || true
  kubectl -n "$NS" delete pvc "data-$m-0" --wait=false >/dev/null 2>&1 || true
done
for m in $members; do
  kubectl -n "$NS" wait --for=delete "pvc/data-$m-0" --timeout=120s >/dev/null 2>&1 || {
    # pvc-protection stays while the API still lists a pod using it; the pod is gone, so release it.
    kubectl -n "$NS" patch pvc "data-$m-0" --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null 2>&1 || true
  }
  kubectl -n "$NS" scale statefulset "$m" --replicas=1 >/dev/null
done
for m in $members; do
  kubectl -n "$NS" wait --for=condition=Ready "pod/$m-0" --timeout=600s >/dev/null
  echo "member $m Ready on $(kubectl -n "$NS" get pod "$m-0" -o jsonpath='{.spec.nodeName}')"
done

# The aggregator reloads the placement map in about a minute; until then reports still name the old node.
for _ in $(seq 1 30); do members_json | jq -e --arg n "$NEW" 'any(.[]; .node == $n)' >/dev/null && break; sleep 5; done
echo ">>> waiting for re-sync / redundancy (up to 20 min)"
for _ in $(seq 1 120); do redundancy_ok && break; sleep 10; done
redundancy_ok || { echo "FAIL: redundancy not restored" >&2; exit 1; }
echo "redundancy restored: $(members_json | jq -c 'group_by(.unit) | map({unit: .[0].unit, nodes: map(.node), counts: map(.count)})')"

collect_ids "$SNAP/ids-after"
lost=$(lost_ids "$SNAP/ids-before" "$SNAP/ids-after" | wc -l | tr -d ' ')
echo "records before=$(wc -l < "$SNAP/ids-before" | tr -d ' ') after=$(wc -l < "$SNAP/ids-after" | tr -d ' ') lost=$lost"
[ "$lost" = 0 ] && echo "PASS: slot $SLOT now on $NEW, nothing lost" || { echo "FAIL: $lost records lost" >&2; exit 1; }
echo "next: scripts/k8s/p1-report.sh (placement) and p1-node-loss.sh on another slot (criterion 6)"
