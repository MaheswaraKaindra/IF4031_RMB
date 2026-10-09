#!/usr/bin/env bash
# P3 criterion 3: the field-team access token expires naturally, refresh works without a new login.
# Expect: 200 before expiry, 401 token_expired after ACCESS_TOKEN_TTL_SECONDS, refresh returns a working
# token, the old access token and the old refresh token are rejected, reusing it revokes the whole family.
# Takes about ACCESS_TOKEN_TTL_SECONDS + 2 seconds (62 s by default).
. "$(dirname "$0")/../lib.sh"

TTL="${ACCESS_TOKEN_TTL_SECONDS:-60}"
refresh() {
    curl -s -X POST "$AUTH_API/refresh" -H 'Content-Type: application/json' \
        -d "$(jq -n --arg t "$1" '{refresh_token:$t}')"
}

step "Login as field-team"
SESSION=$(login field-team "$AUTH_CLIENT_FIELD_TEAM_SECRET")
ACCESS=$(jq -r .access_token <<<"$SESSION")
REFRESH=$(jq -r .refresh_token <<<"$SESSION")
jq -c '{token_type, expires_in, refresh_expires_in, scope}' <<<"$SESSION"
echo "events with the fresh token: HTTP $(code -H "Authorization: Bearer $ACCESS" "$CLIENT_API/events?fields=latitude")"

step "Waiting $((TTL + 2)) s for the access token to expire naturally"
sleep $((TTL + 2))

step "The same access token after expiry"
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $ACCESS" "$CLIENT_API/events"

step "Refresh without logging in again"
NEW=$(refresh "$REFRESH")
NEW_ACCESS=$(jq -r .access_token <<<"$NEW")
NEW_REFRESH=$(jq -r .refresh_token <<<"$NEW")
echo "events with the new token: HTTP $(code -H "Authorization: Bearer $NEW_ACCESS" "$CLIENT_API/events")"

step "Old tokens after the refresh"
echo "old access token: HTTP $(code -H "Authorization: Bearer $ACCESS" "$CLIENT_API/events")"
echo "old refresh token reused: HTTP $(code -X POST "$AUTH_API/refresh" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$REFRESH" '{refresh_token:$t}')")"
echo "new refresh token after the reuse (family revoked): HTTP $(code -X POST "$AUTH_API/refresh" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg t "$NEW_REFRESH" '{refresh_token:$t}')")"

step "Auth Service log"
docker compose logs --since "$((TTL + 30))s" auth-service | grep -E 'token issued|reuse detected' | tail -4
