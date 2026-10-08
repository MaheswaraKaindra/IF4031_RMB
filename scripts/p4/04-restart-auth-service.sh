#!/usr/bin/env bash
# P4 criterion 1: stop, rebuild and restart auth-service alone.
# Expect: a token issued earlier still gets HTTP 200 from /events while auth-service is down,
# a new login fails, the diff shows only auth-service changed, and logins work again afterwards.
. "$(dirname "$0")/../lib.sh"

BEFORE=$(mktemp)
AFTER=$(mktemp)
trap 'rm -f "$BEFORE" "$AFTER"; docker compose up -d --no-deps auth-service >/dev/null' EXIT

step "Snapshot of container start times"
snapshot "$BEFORE"

step "Issue a token, then stop auth-service"
TOKEN=$(mint)
docker compose stop auth-service

step "While auth-service is down"
curl -s -o /dev/null -w 'events with an issued token: HTTP %{http_code}\n' \
    -H "Authorization: Bearer $TOKEN" "$CLIENT_API/events?limit=1"
curl -s -m 3 -o /dev/null -w 'new login: HTTP %{http_code}\n' -X POST "$AUTH_API/token" || echo "new login fails (expected)"

step "Rebuilding (no cache) and starting only auth-service"
docker compose build --no-cache auth-service
docker compose up -d --no-deps auth-service
wait_healthy auth-service

step "Start times before and after: only auth-service may differ"
snapshot "$AFTER"
diff "$BEFORE" "$AFTER"

step "All containers, and logins work again"
docker compose ps --format '{{.Name}} {{.Status}}'
[ -n "$(mint)" ] && echo "mint works again"
