#!/usr/bin/env bash
# P2: the same load test while PVMBG is in outage.
# Expect: stale_volcanic 100%, http_req_failed 0%, BMKG-only p95 still under 300 ms.
. "$(dirname "$0")/../lib.sh"

trap 'pvmbg_toggle outage false >/dev/null' EXIT

step "Outage ON, waiting 15 s"
pvmbg_toggle outage true
sleep 15

step "Load test during the outage"
run_k6 outage

step "Outage OFF"
pvmbg_toggle outage false
