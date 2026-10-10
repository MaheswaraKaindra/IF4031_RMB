#!/usr/bin/env bash
# Observability: one correlation ID shows up in the logs of two services, with outgoing-call latency.
# Expect: the same x-correlation-id echoed back, and log lines from client-api and aggregator.
. "$(dirname "$0")/../lib.sh"

ID="demo-corr-$(date +%s)"

step "Request with x-correlation-id: $ID"
curl -s -o /dev/null -D - -H "x-correlation-id: $ID" -H "Authorization: Bearer $(mint)" \
    "$CLIENT_API/events?limit=1" | grep -i correlation

step "Log lines carrying $ID"
sleep 1
docker compose logs --since 1m client-api aggregator | grep "$ID"
