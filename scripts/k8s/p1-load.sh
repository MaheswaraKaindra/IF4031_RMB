#!/usr/bin/env bash
# P1 criterion 1: load a skewed catalog and report data distribution per node.
# Usage: scripts/k8s/p1-load.sh [count=50000]
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
COUNT=${1:-50000}
echo ">>> loading $COUNT synthetic events (geographically skewed: 40% Sumatera Barat, 25% Jawa Barat, ...)"
tool load --count "$COUNT" | jq -c 'select(has("cmd"))'
echo ">>> distribution per node (copies held), share of the logical dataset per node"
tool report | tee /tmp/p1-report.$$ | jq -c 'select(has("logical_records"))'
jq -r 'select(has("member")) | [.node, .unit, .member, .role, (.count|tostring)] | @tsv' /tmp/p1-report.$$ | sort | column -t
share=$(jq -r 'select(has("max_node_share")) | .max_node_share' /tmp/p1-report.$$)
rm -f /tmp/p1-report.$$
if jq -en --argjson s "$share" '$s < 1' >/dev/null; then echo "PASS: no node holds the whole dataset (max node share $share)"; else echo "FAIL: a node holds the whole dataset (share $share)" >&2; exit 1; fi
