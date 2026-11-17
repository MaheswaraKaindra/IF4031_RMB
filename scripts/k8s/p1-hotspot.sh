#!/usr/bin/env bash
# P1 criterion 2: write surge concentrated in ONE region; per-node write load must stay spread.
# Usage: scripts/k8s/p1-hotspot.sh [count=20000] [region=sumatra]
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
COUNT=${1:-20000}; REGION=${2:-sumatra}
echo ">>> burst of $COUNT writes, all in region '$REGION' (the hottest region of the dataset)"
tool burst --count "$COUNT" --region "$REGION" | tee /tmp/p1-burst.$$ | jq -c 'select(has("cmd"))'
jq -r 'select(has("member")) | [.node, .unit, .member, .role, ("inserts+" + (.insert_delta|tostring)), ("count=" + (.count|tostring))] | @tsv' /tmp/p1-burst.$$ | sort | column -t
# Primaries take the writes; secondaries replay them. Compare the spread of insert deltas across PRIMARIES.
ratio=$(jq -s '[.[] | select(has("member") and .role=="primary") | .insert_delta] | (max / (min | if . == 0 then 1 else . end))' /tmp/p1-burst.$$)
rm -f /tmp/p1-burst.$$
echo "primary write-load max/min ratio: $ratio (1.0 = perfectly even)"
jq -en --argjson r "$ratio" '$r < 2' >/dev/null && echo "PASS: hot region spread over shards (ratio < 2)" || { echo "FAIL: write load concentrated on one node" >&2; exit 1; }
