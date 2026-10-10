#!/usr/bin/env bash
# P3 extra: repeated failed logins from one address are throttled.
# Expect: 401 until AUTH_MAX_FAILED_ATTEMPTS failures are reached, then 429 with Retry-After.
# Logins from this host stay blocked for AUTH_FAILURE_WINDOW_SECONDS afterwards, so run it last.
. "$(dirname "$0")/../lib.sh"

step "15 logins with a wrong secret"
for i in $(seq 1 15); do
    printf '%s ' "$(code -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
        -d '{"client_id":"bnpb-ops","client_secret":"wrong"}')"
done
echo

step "Headers of a throttled request"
curl -s -D - -o /dev/null -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
    -d '{"client_id":"bnpb-ops","client_secret":"wrong"}' | grep -i -E '^HTTP|retry-after'
