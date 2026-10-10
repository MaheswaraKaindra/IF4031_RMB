#!/usr/bin/env bash
# P2 criterion 1 prerequisite: prove PVMBG really answers in about 3 s.
# Set PVMBG_DELAY_MIN_MS=3000 and PVMBG_DELAY_MAX_MS=3000 in .env and recreate the stack first.
. "$(dirname "$0")/../lib.sh"

step "Configured delay in .env: min=${PVMBG_DELAY_MIN_MS:-unset} max=${PVMBG_DELAY_MAX_MS:-unset}"

step "Measured PVMBG response time (4 calls, expect about 2.8 to 3.0 s each)"
for i in 1 2 3 4; do
    curl -s -o /dev/null -w "PVMBG answered in %{time_total}s\n" \
        -H "Authorization: Bearer $PVMBG_TOKEN" "$PVMBG_API/volcanic-reports"
done
