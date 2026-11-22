#!/usr/bin/env bash
# Assign the three "store slots" used by k8s/store to real nodes (once per cluster).
# Usage: scripts/m2/label-nodes.sh <node-1> <node-2> <node-3>      (names from `kubectl get nodes`)
# Slot -> node decides where every shard member lives (see k8s/store/generate.mjs). Slots must be on 3 DIFFERENT nodes
# (separate kernels in the demo), otherwise "no single node holds the whole dataset" cannot hold.
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: $0 <node-1> <node-2> <node-3>" >&2; exit 1; }
[ "$(printf '%s\n' "$@" | sort -u | wc -l | tr -d ' ')" = 3 ] || { echo "the three nodes must be different" >&2; exit 1; }
i=1
for n in "$@"; do
  kubectl label node "$n" "bnpb.io/store-slot=$i" --overwrite
  i=$((i + 1))
done
kubectl get nodes -L bnpb.io/store-slot
