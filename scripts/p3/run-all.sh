#!/usr/bin/env bash
# Runs the P3 checks in order. The token expiry check waits for ACCESS_TOKEN_TTL_SECONDS,
# and the login throttle check blocks logins from this host for a while, so both are opt-in:
#   ./scripts/p3/run-all.sh                credential isolation, Media scope, no committed credentials
#   ./scripts/p3/run-all.sh --with-expiry  the same plus token expiry and refresh (about 62 s)
#   ./scripts/p3/run-all.sh --all          everything, the login throttle last
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/01-credential-isolation.sh"
"$DIR/02-media-scope.sh"
"$DIR/04-no-committed-credentials.sh"

case "${1:-}" in
    --with-expiry)
        "$DIR/03-token-refresh.sh"
        ;;
    --all)
        "$DIR/03-token-refresh.sh"
        "$DIR/05-login-throttle.sh"
        ;;
esac
