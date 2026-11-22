#!/usr/bin/env bash
# Snapshot of placement + counts for screenshots: per node holdings, per-source checksums, location of a sample record.
set -euo pipefail
source "$(dirname "$0")/p1-lib.sh"
start_forward
tool report | jq -c .
id=$(audit "/internal/audit/events?limit=1" | jq -r '.items[0].hazard_id')
echo ">>> /internal/audit/location for $id"
audit "/internal/audit/location?hazard_id=$id" | jq .
echo ">>> store units"
audit "/internal/store/status" | jq -c .
