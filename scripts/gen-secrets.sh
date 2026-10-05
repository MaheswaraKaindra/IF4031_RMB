#!/usr/bin/env bash
# Generate all credentials and keys for .env.
# Usage: ./scripts/gen-secrets.sh >> .env
set -euo pipefail

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/private.pem" 2>/dev/null
openssl pkey -in "$tmp/private.pem" -pubout -out "$tmp/public.pem"

b64() { openssl base64 -A -in "$1"; }
b64url() { openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '=\n'; }
sha256() { printf '%s' "$1" | openssl dgst -sha256 | awk '{print $NF}'; }

bmkg_key="bmkg_$(openssl rand -hex 32)"
pvmbg_token="pvmbg.v1.$(b64url 32)"
media_secret=$(b64url 32)
field_team_secret=$(b64url 32)
bnpb_ops_secret=$(b64url 32)
mongo_password=$(openssl rand -hex 24)
rabbitmq_password=$(openssl rand -hex 24)

cat <<EOF
X_BMKG_KEY=$bmkg_key
X_BMKG_KEY_SHA256=$(sha256 "$bmkg_key")
PVMBG_TOKEN=$pvmbg_token
PVMBG_TOKEN_SHA256=$(sha256 "$pvmbg_token")
JWT_PRIVATE_KEY_B64=$(b64 "$tmp/private.pem")
JWT_PUBLIC_KEY_B64=$(b64 "$tmp/public.pem")
AUTH_CLIENT_MEDIA_SECRET=$media_secret
AUTH_CLIENT_MEDIA_SECRET_SHA256=$(sha256 "$media_secret")
AUTH_CLIENT_FIELD_TEAM_SECRET=$field_team_secret
AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256=$(sha256 "$field_team_secret")
AUTH_CLIENT_BNPB_OPS_SECRET=$bnpb_ops_secret
AUTH_CLIENT_BNPB_OPS_SECRET_SHA256=$(sha256 "$bnpb_ops_secret")
MONGO_PASSWORD=$mongo_password
RABBITMQ_PASSWORD=$rabbitmq_password
EOF
