#!/usr/bin/env bash
# Create one Kubernetes Secret per component from .env (values never touch git or the command line).
# Usage: scripts/k8s/create-secrets.sh [path-to-env-file]   (default: .env, produced by scripts/gen-secrets.sh)
# All values are read and validated first; nothing is applied unless every required key is present.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && cd .. && pwd)
ENV_FILE=${1:-$ROOT/.env}
NS=${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}

[ -f "$ENV_FILE" ] || { echo "$ENV_FILE not found: cp .env.example .env && ./scripts/gen-secrets.sh >> .env" >&2; exit 1; }

# Last assignment wins (gen-secrets.sh output is appended after the .env.example placeholders).
raw() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }

# Required keys: fail loudly, reject empty values and the .env.example placeholders.
need() {
  local v
  v=$(raw "$1")
  if [ -z "$v" ] || [[ "$v" == ganti-dengan-* ]]; then
    echo "$1 is missing or still a placeholder in $ENV_FILE (run scripts/gen-secrets.sh >> .env)" >&2
    exit 1
  fi
  printf '%s' "$v"
}

# Plain assignments so a failing `need` aborts the script (set -e ignores failures inside
# command substitutions that are only arguments of another command).
X_BMKG_KEY_SHA256=$(need X_BMKG_KEY_SHA256)
PVMBG_TOKEN_SHA256=$(need PVMBG_TOKEN_SHA256)
X_BMKG_KEY=$(need X_BMKG_KEY)
PVMBG_TOKEN=$(need PVMBG_TOKEN)
MONGO_PASSWORD=$(need MONGO_PASSWORD)
RABBITMQ_PASSWORD=$(need RABBITMQ_PASSWORD)
JWT_PRIVATE_KEY_B64=$(need JWT_PRIVATE_KEY_B64)
JWT_PUBLIC_KEY_B64=$(need JWT_PUBLIC_KEY_B64)
AUTH_CLIENT_MEDIA_SECRET_SHA256=$(need AUTH_CLIENT_MEDIA_SECRET_SHA256)
AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256=$(need AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256)
AUTH_CLIENT_BNPB_OPS_SECRET_SHA256=$(need AUTH_CLIENT_BNPB_OPS_SECRET_SHA256)
MONGO_USER=$(raw MONGO_USERNAME); MONGO_USER=${MONGO_USER:-bnpb}
RABBIT_USER=$(raw RABBITMQ_USERNAME); RABBIT_USER=${RABBIT_USER:-bnpb}
RABBITMQ_URL="amqp://$RABBIT_USER:$RABBITMQ_PASSWORD@rabbitmq:5672"
MONGO_URI="mongodb://$MONGO_USER:$MONGO_PASSWORD@mongo:27017/bnpb_canonical_store?authSource=admin"

STORE_MODE=${STORE_MODE:-single}
AUDIT_TOKEN=$(raw AUDIT_TOKEN)   # optional in single mode; audit endpoints answer 503 until it is set
SHARDED_ENV=()
if [ "$STORE_MODE" = sharded ]; then
  MONGO_APP_PASSWORD=$(need MONGO_APP_PASSWORD)
  STORE_PROBE_PASSWORD=$(need STORE_PROBE_PASSWORD)
  MONGO_KEYFILE=$(need MONGO_KEYFILE)
  AUDIT_TOKEN=$(need AUDIT_TOKEN)
  PANTAI_AUTH_TOKEN=$(need PANTAI_AUTH_TOKEN)
  # The aggregator authenticates as its own least-privilege user (readWrite on one database) through mongos.
  MONGO_URI="mongodb://aggregator:$MONGO_APP_PASSWORD@mongos:27017/bnpb_canonical_store?authSource=admin"
  SHARDED_ENV=("STORE_MODE=sharded" "STORE_PROBE_USER=probe" "STORE_PROBE_PASSWORD=$STORE_PROBE_PASSWORD")
fi

tmp=$(mktemp)
chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT

# apply_secret <name> KEY=VALUE...
apply_secret() {
  local name=$1; shift
  : > "$tmp"
  local kv
  for kv in "$@"; do printf '%s\n' "$kv" >> "$tmp"; done
  kubectl -n "$NS" create secret generic "$name" --from-env-file="$tmp" --dry-run=client -o yaml \
    | kubectl -n "$NS" apply -f - >/dev/null
  echo "secret/$name applied"
}

apply_secret mock-bmkg-secret  "X_BMKG_KEY_SHA256=$X_BMKG_KEY_SHA256"
apply_secret mock-pvmbg-secret "PVMBG_TOKEN_SHA256=$PVMBG_TOKEN_SHA256"
apply_secret mongo-secret \
  "MONGO_INITDB_ROOT_USERNAME=$MONGO_USER" "MONGO_INITDB_ROOT_PASSWORD=$MONGO_PASSWORD"
apply_secret rabbitmq-secret \
  "RABBITMQ_DEFAULT_USER=$RABBIT_USER" "RABBITMQ_DEFAULT_PASS=$RABBITMQ_PASSWORD"
apply_secret aggregator-secret \
  "X_BMKG_KEY=$X_BMKG_KEY" "PVMBG_TOKEN=$PVMBG_TOKEN" \
  "MONGO_URI=$MONGO_URI" "RABBITMQ_URL=$RABBITMQ_URL" \
  ${AUDIT_TOKEN:+"AUDIT_TOKEN=$AUDIT_TOKEN"} ${SHARDED_ENV[@]+"${SHARDED_ENV[@]}"}
apply_secret client-api-secret "JWT_PUBLIC_KEY_B64=$JWT_PUBLIC_KEY_B64"
apply_secret auth-service-secret \
  "JWT_PRIVATE_KEY_B64=$JWT_PRIVATE_KEY_B64" \
  "AUTH_CLIENT_MEDIA_SECRET_SHA256=$AUTH_CLIENT_MEDIA_SECRET_SHA256" \
  "AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256=$AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256" \
  "AUTH_CLIENT_BNPB_OPS_SECRET_SHA256=$AUTH_CLIENT_BNPB_OPS_SECRET_SHA256"
apply_secret consumers-secret "RABBITMQ_URL=$RABBITMQ_URL"

if [ "$STORE_MODE" = sharded ]; then
  apply_secret store-users "MONGO_APP_PASSWORD=$MONGO_APP_PASSWORD" "STORE_PROBE_PASSWORD=$STORE_PROBE_PASSWORD"
  printf '%s' "$MONGO_KEYFILE" > "$tmp"
  kubectl -n "$NS" create secret generic mongo-keyfile --from-file=keyfile="$tmp" --dry-run=client -o yaml \
    | kubectl -n "$NS" apply -f - >/dev/null
  echo "secret/mongo-keyfile applied"
  apply_secret pantai-token "token=$PANTAI_AUTH_TOKEN"
fi
