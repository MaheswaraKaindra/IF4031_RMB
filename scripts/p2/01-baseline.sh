#!/usr/bin/env bash
# P2 baseline: with everything healthy both sources are fresh.
# Expect: both BMKG and PVMBG have stale=false, stale_since=null.
. "$(dirname "$0")/../lib.sh"

step "Baseline: /events with all services healthy"
timed_events 'limit=3' '{count: (.events|length), sources}'
