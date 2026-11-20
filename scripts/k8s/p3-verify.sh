#!/usr/bin/env bash
# P3 Verification Helper: incompatible schema changes, malformed payloads, Ops-only inspection & ordered replay,
# and durable POST /field-reports -> 202 Accepted even with broker down.
set -euo pipefail

NS=sistem-informasi-kebencanaan-bnpb
CLIENT_API=${CLIENT_API:-http://localhost:8080}
AUTH_API=${AUTH_API:-http://localhost:8090}
AUDIT_API=${AUDIT_API:-http://localhost:3001}
PVMBG_URL=${PVMBG_URL:-http://localhost:8082}

: "${AUTH_CLIENT_MEDIA_SECRET:?set from .env}"
: "${AUTH_CLIENT_FIELD_TEAM_SECRET:?set from .env}"
: "${AUTH_CLIENT_BNPB_OPS_SECRET:?set from .env}"
: "${PVMBG_TOKEN:?set from .env}"
: "${AUDIT_TOKEN:?set from .env}"

mint() {
  curl -sf -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
    -d "{\"client_id\":\"$1\",\"client_secret\":\"$2\"}" | jq -r .access_token
}

MEDIA=$(mint media "$AUTH_CLIENT_MEDIA_SECRET")
FIELD=$(mint field-team "$AUTH_CLIENT_FIELD_TEAM_SECRET")
OPS=$(mint bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET")

echo "=== 1. Trigger incompatible PVMBG schema (P3-K1) ==="
curl -sf -X POST "$PVMBG_URL/admin/schema-version" \
  -H "Authorization: Bearer $PVMBG_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"mode":"mixed_incompatible"}' | jq

echo "=== 2. Check Internal Ops authorization on /unprocessed (P3-K5) ==="
echo "media -> GET /unprocessed: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $MEDIA" "$CLIENT_API/unprocessed")"
echo "field-team -> GET /unprocessed: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $FIELD" "$CLIENT_API/unprocessed")"
echo "bnpb-ops -> GET /unprocessed: $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $OPS" "$CLIENT_API/unprocessed")"

echo "=== 3. Audit API /internal/audit/unprocessed (Lampiran A) ==="
curl -sf -H "Authorization: Bearer $AUDIT_TOKEN" "$AUDIT_API/internal/audit/unprocessed?limit=10" | jq

echo "=== 4. Durable POST /field-reports -> 202 Accepted (P3-K6) ==="
echo "media POST /field-reports: $(curl -s -o /dev/null -w '%{http_code}' -X POST "$CLIENT_API/field-reports" -H "Authorization: Bearer $MEDIA" -H 'Content-Type: application/json' -d '{}')"
curl -i -s -X POST "$CLIENT_API/field-reports" \
  -H "Authorization: Bearer $FIELD" \
  -H "Idempotency-Key: idem-demo-1" \
  -H 'Content-Type: application/json' \
  -d '{"report_id":"FR-DEMO-1","hazard_type":"COASTAL","severity":"AWAS","area_name":"Padang","latitude":-0.95,"longitude":100.35,"occurred_at":"2026-11-18T12:00:00Z"}'

echo ""
echo "=== 5. Enable v2 schema rules + replay parked messages (P3-K4) ==="
curl -sf -X POST "$CLIENT_API/unprocessed/schema-rules" \
  -H "Authorization: Bearer $OPS" \
  -H 'Content-Type: application/json' \
  -d '{"enablePvmbgV2Compat":true}' | jq
curl -sf -X POST "$CLIENT_API/unprocessed/replay" \
  -H "Authorization: Bearer $OPS" \
  -H 'Content-Type: application/json' \
  -d '{"source":"PVMBG"}' | jq
