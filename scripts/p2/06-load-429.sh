#!/usr/bin/env bash
# P2: controlled rejection. MAX_IN_FLIGHT is lowered to 5 and 200 VUs overflow it.
# Expect: rejected_429 well above 0, http_req_failed 0%, no 5xx, no crash.
# The default limit (100) is restored at the end.
. "$(dirname "$0")/../lib.sh"

restore() {
    step "Restoring MAX_IN_FLIGHT=${MAX_IN_FLIGHT:-100}"
    docker compose up -d --wait client-api >/dev/null
    printf 'client-api MAX_IN_FLIGHT is now: '
    docker compose exec -T client-api printenv MAX_IN_FLIGHT
}
trap restore EXIT

step "client-api with MAX_IN_FLIGHT=5"
MAX_IN_FLIGHT=5 docker compose up -d --wait client-api >/dev/null

step "Load test, 100 + 100 VUs"
run_k6 429 -e VUS_EACH=100
