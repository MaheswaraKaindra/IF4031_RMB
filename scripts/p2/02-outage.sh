#!/usr/bin/env bash
# P2 criterion 3: PVMBG outage.
# Expect during the outage: HTTP 200, PVMBG stale=true with stale_since, BMKG stale=false.
# Expect after it: PVMBG fresh again without any restart.
. "$(dirname "$0")/../lib.sh"

trap 'pvmbg_toggle outage false >/dev/null' EXIT

step "Outage ON"
pvmbg_toggle outage true

step "Waiting 15 s (longer than STALE_AFTER_MS)"
sleep 15

step "During the outage"
timed_events 'limit=3' '{count: (.events|length), BMKG: .sources.BMKG, PVMBG: .sources.PVMBG}'

step "Aggregator log: failed PVMBG polls are recorded, the loop keeps running"
docker compose logs --since 20s aggregator | grep -i -E 'pvmbg' | tail -4

step "Outage OFF"
pvmbg_toggle outage false

step "Waiting 8 s for the next successful poll"
sleep 8

step "After recovery (no restart)"
timed_events 'limit=3' '.sources'
