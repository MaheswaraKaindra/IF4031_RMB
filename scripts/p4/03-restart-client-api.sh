#!/usr/bin/env bash
# P4 criterion 1: stop, rebuild and restart client-api alone.
# Expect: the Aggregator keeps polling while it is down, the diff shows only client-api changed,
# and every container is healthy again.
. "$(dirname "$0")/../lib.sh"

BEFORE=$(mktemp)
AFTER=$(mktemp)
trap 'rm -f "$BEFORE" "$AFTER"' EXIT

step "Snapshot of container start times"
snapshot "$BEFORE"

step "Stopping client-api"
docker compose stop client-api
sleep 15

step "While client-api is down"
printf 'BMKG polls by the aggregator in the last 15 s: '
docker compose logs --since 15s aggregator | grep -c '"call":"GET /seismic-events"'
curl -s -m 3 -o /dev/null -w 'client-api now: HTTP %{http_code}\n' "$CLIENT_API/health" || echo "client-api down (expected)"

step "Rebuilding (no cache) and starting only client-api"
docker compose build --no-cache client-api
docker compose up -d --no-deps client-api
wait_healthy client-api

step "Start times before and after: only client-api may differ"
snapshot "$AFTER"
diff "$BEFORE" "$AFTER"

step "All containers"
docker compose ps --format '{{.Name}} {{.Status}}'
