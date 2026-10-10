#!/usr/bin/env bash
# P3 criterion 2: the Media client only receives Ringkasan fields, enforced by the server.
# Expect: wrong or borrowed secrets get 401, no token gets 401, Media sees only the 7 Ringkasan fields,
# Media asking for a raw field gets 403, field-team and bnpb-ops get all 11 fields.
. "$(dirname "$0")/../lib.sh"

step "Each client has its own secret"
echo "media with a wrong secret: HTTP $(code -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
    -d '{"client_id":"media","client_secret":"wrong"}')"
echo "field-team with the media secret: HTTP $(code -X POST "$AUTH_API/token" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg s "$AUTH_CLIENT_MEDIA_SECRET" '{client_id:"field-team",client_secret:$s}')")"
echo "/events without a token: HTTP $(code "$CLIENT_API/events")"

MEDIA=$(login media "$AUTH_CLIENT_MEDIA_SECRET" | jq -r .access_token)
FIELD=$(login field-team "$AUTH_CLIENT_FIELD_TEAM_SECRET" | jq -r .access_token)

step "Fields returned to media (Ringkasan only)"
curl -s -H "Authorization: Bearer $MEDIA" "$CLIENT_API/events?limit=1" | jq -c '.events[0] | keys'

step "Media explicitly asking for raw fields"
for f in latitude attributes source_ref_id; do
    echo "media fields=$f: HTTP $(code -H "Authorization: Bearer $MEDIA" "$CLIENT_API/events?fields=$f")"
done
curl -s -H "Authorization: Bearer $MEDIA" "$CLIENT_API/events?fields=latitude" | jq -c .

step "Fields returned to field-team and bnpb-ops (Ringkasan and Mentah)"
curl -s -H "Authorization: Bearer $FIELD" "$CLIENT_API/events?limit=1" | jq -c '.events[0] | keys'
echo "bnpb-ops fields=latitude: HTTP $(code -H "Authorization: Bearer $(mint)" "$CLIENT_API/events?fields=latitude")"
