#!/usr/bin/env bash
# P2: the Aggregator is down. Expect a clean 503 with a correlation_id within about 2 s (no hang),
# /health of the Client API still 200, and 200 again after the Aggregator is back.
. "$(dirname "$0")/../lib.sh"

trap 'docker compose start aggregator >/dev/null' EXIT

step "Stopping the Aggregator"
docker compose stop aggregator

step "/events while the Aggregator is down (twice)"
timed_events 'limit=3'
timed_events 'limit=3'

step "Client API /health is still up"
curl -s -w '\nHTTP %{http_code}\n' "$CLIENT_API/health"

step "Starting the Aggregator again"
docker compose start aggregator >/dev/null
wait_healthy aggregator

step "/events after recovery"
timed_events 'limit=3' '{count: (.events|length), sources}'
