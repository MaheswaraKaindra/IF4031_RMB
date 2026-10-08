#!/usr/bin/env bash
# P4 criterion 3: only the Aggregator can reach the Canonical Store.
# Expect: no host port on mongo, store network internal with only mongo + aggregator,
# client-api cannot resolve mongo and has no MONGO variables, and it reads through the Aggregator API.
# The MONGO_URI password is masked, so the output is safe to screenshot.
. "$(dirname "$0")/../lib.sh"

step "1. mongo publishes no port to the host (only the name should be printed)"
docker compose ps --format '{{.Name}} {{.Ports}}' | grep mongo

step "2. the store network is internal and has two members"
docker network inspect "${COMPOSE_PROJECT_NAME:-bnpb}_store" \
    --format 'internal={{.Internal}} members: {{range .Containers}}{{.Name}} {{end}}'

step "3. client-api cannot reach mongo"
docker compose exec -T client-api sh -c 'nc -zv -w2 mongo 27017 || echo "cannot reach mongo"'
docker compose exec -T client-api sh -c 'wget -q -T2 -O- http://mongo:27017 || echo "cannot reach mongo"'

step "4. client-api has no MONGO variables, MONGO_URI exists only under the aggregator"
docker compose exec -T client-api printenv | grep -i mongo || echo "no MONGO variables"
docker compose config | grep -n MONGO_URI | sed -E 's#(://[^:]+:)[^@]+@#\1****@#'

step "5. client-api reads through the Aggregator API"
timed_events 'limit=1' '{count: (.events|length)}' >/dev/null
docker compose logs --since 1m client-api | grep '"call":"GET /internal/events"' | tail -2
