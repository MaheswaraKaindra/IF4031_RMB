#!/usr/bin/env bash
# P2 criteria 1 and 2: 25 BMKG-only + 25 volcanic VUs for 60 s with PVMBG at 3 s.
# Expect: both thresholds pass (BMKG-only p95 < 300 ms, failed < 1%), stale_volcanic about 0%.
# Prerequisite: PVMBG_DELAY_MIN_MS and PVMBG_DELAY_MAX_MS are 3000 in .env and the stack was recreated.
. "$(dirname "$0")/../lib.sh"

if [ "${PVMBG_DELAY_MIN_MS:-}" != 3000 ] || [ "${PVMBG_DELAY_MAX_MS:-}" != 3000 ]; then
    echo "PVMBG delay is not 3000 in .env (min=${PVMBG_DELAY_MIN_MS:-unset}, max=${PVMBG_DELAY_MAX_MS:-unset})."
    echo "Set both to 3000 and recreate the stack: docker compose down -v && docker compose up -d --build --wait"
    exit 1
fi

step "Load test, PVMBG delay 3 s"
run_k6 delay3s

step "No container may have crashed"
docker compose ps --format '{{.Name}} {{.Status}}'
