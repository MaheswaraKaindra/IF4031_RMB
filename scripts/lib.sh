#!/usr/bin/env bash
# Shared helpers for scripts/p2 and scripts/p4. Source it, do not run it.
# Needs: a running stack (docker compose up -d --build --wait), a filled .env, docker, curl, jq.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

[ -f .env ] || { echo ".env not found, run: cp .env.example .env && ./scripts/gen-secrets.sh >> .env"; exit 1; }
set -a; . ./.env; set +a

for cmd in docker curl jq; do
    command -v "$cmd" >/dev/null || { echo "$cmd is required"; exit 1; }
done

CLIENT_API="http://localhost:${CLIENT_API_PORT:-8080}"
AUTH_API="http://localhost:${AUTH_PORT:-8090}"
PVMBG_API="http://localhost:${PVMBG_PORT:-8082}"

# Load test results are written to load-test/results/<RESULT_PREFIX>-<name>.{txt,json}.
# The default never overwrites the committed final-* results.
RESULT_PREFIX="${RESULT_PREFIX:-rerun}"

curl -sf -m 3 "$CLIENT_API/health" >/dev/null || { echo "Stack is not running, start it: docker compose up -d --build --wait"; exit 1; }

step() { printf '\n== %s\n' "$*"; }

mint() {
    curl -s -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg s "$AUTH_CLIENT_BNPB_OPS_SECRET" '{client_id:"bnpb-ops",client_secret:$s}')" \
        | jq -r '.access_token // empty'
}

# timed_events <query string> [jq filter]: GET /events with a fresh token, prints status code, time and body.
timed_events() {
    local out body meta
    out=$(curl -s -m 10 -w '\n%{http_code} %{time_total}' -H "Authorization: Bearer $(mint)" "$CLIENT_API/events?$1")
    body=${out%$'\n'*}
    meta=${out##*$'\n'}
    echo "HTTP ${meta% *} in ${meta#* }s"
    echo "$body" | jq -c "${2:-.}" 2>/dev/null || echo "$body"
}

# pvmbg_toggle <outage|schema-version> <true|false>: the admin endpoints flip a switch,
# so this flips again when the first call landed on the wrong state.
pvmbg_toggle() {
    local msg
    msg=$(curl -s -X POST "$PVMBG_API/admin/$1" -H "Authorization: Bearer $PVMBG_TOKEN" | jq -r .message)
    if [ "${msg##* }" != "$2" ]; then
        msg=$(curl -s -X POST "$PVMBG_API/admin/$1" -H "Authorization: Bearer $PVMBG_TOKEN" | jq -r .message)
    fi
    echo "$msg"
}

# wait_healthy <service> [timeout seconds]
wait_healthy() {
    local svc=$1 timeout=${2:-90} waited=0 id status
    while [ "$waited" -lt "$timeout" ]; do
        id=$(docker compose ps -q "$svc")
        status=$([ -n "$id" ] && docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id")
        [ "$status" = healthy ] && return 0
        sleep 2
        waited=$((waited + 2))
    done
    echo "$svc is not healthy after ${timeout}s"
    return 1
}

# snapshot <file>: start time of every container, to prove which ones were restarted.
snapshot() {
    docker inspect -f '{{.Name}} {{.State.StartedAt}}' $(docker compose ps -q) | sort > "$1"
}

mongo_eval() {
    docker compose exec -T mongo mongosh -u "$MONGO_USERNAME" -p "$MONGO_PASSWORD" \
        --authenticationDatabase admin bnpb_canonical_store --quiet --eval "$1"
}

# run_k6 <name> [extra k6 args]: runs load-test/events.js and saves the summary.
run_k6() {
    local name=$1
    shift
    command -v k6 >/dev/null || { echo "k6 is required (brew install k6)"; exit 1; }
    mkdir -p load-test/results
    k6 run --summary-export "load-test/results/$RESULT_PREFIX-$name.json" \
        -e CLIENT_SECRET="$AUTH_CLIENT_BNPB_OPS_SECRET" "$@" load-test/events.js \
        | tee "load-test/results/$RESULT_PREFIX-$name.txt"
    echo "saved: load-test/results/$RESULT_PREFIX-$name.{txt,json}"
}
