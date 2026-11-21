#!/usr/bin/env bash
# End-to-end smoke: token from auth-service -> GET /events via client-api, through port-forward.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env}
NS=sistem-informasi-kebencanaan-bnpb
AUTH_LOCAL=${AUTH_LOCAL:-18090}
API_LOCAL=${API_LOCAL:-18080}

secret=$(grep -E '^AUTH_CLIENT_FIELD_TEAM_SECRET=' "$ENV_FILE" | tail -n1 | cut -d= -f2-)
[ -n "$secret" ] || { echo "AUTH_CLIENT_FIELD_TEAM_SECRET missing in $ENV_FILE" >&2; exit 1; }

kubectl -n "$NS" port-forward svc/auth-service "$AUTH_LOCAL:8090" >/dev/null &
pf1=$!
kubectl -n "$NS" port-forward svc/client-api "$API_LOCAL:8080" >/dev/null &
pf2=$!
trap 'kill $pf1 $pf2 2>/dev/null || true' EXIT
sleep 3

for i in $(seq 1 30); do
  token=$(curl -sf -X POST "http://127.0.0.1:$AUTH_LOCAL/token" -H 'content-type: application/json' \
    -d "{\"client_id\":\"field-team\",\"client_secret\":\"$secret\"}" | jq -r .access_token) || token=""
  if [ -n "$token" ] && [ "$token" != null ]; then
    body=$(curl -sf "http://127.0.0.1:$API_LOCAL/events?limit=5" -H "authorization: Bearer $token") || body=""
    n=$(jq '.events | length' <<<"$body" 2>/dev/null || echo 0)
    if [ "$n" -gt 0 ]; then
      echo "ok: /events returned $n events; sources: $(jq -c '.sources' <<<"$body")"
      exit 0
    fi
  fi
  sleep 3
done
echo "FAIL: no events returned through client-api within ~90s" >&2
exit 1
