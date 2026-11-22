#!/usr/bin/env bash
# Runs the P3 checks in order. The token expiry check waits for ACCESS_TOKEN_TTL_SECONDS,
# and the login throttle check blocks logins from this host for a while, so both are opt-in:
#   ./scripts/m1/p3-run-all.sh                credential isolation, Media scope, no committed credentials
#   ./scripts/m1/p3-run-all.sh --with-expiry  the same plus token expiry and refresh (about 62 s)
#   ./scripts/m1/p3-run-all.sh --all          everything, the login throttle last
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/p3-01-credential-isolation.sh"
"$DIR/p3-02-media-scope.sh"
"$DIR/p3-04-no-committed-credentials.sh"

case "${1:-}" in
    --with-expiry)
        "$DIR/p3-03-token-refresh.sh"
        ;;
    --all)
        "$DIR/p3-03-token-refresh.sh"
        "$DIR/p3-05-login-throttle.sh"
        ;;
esac
