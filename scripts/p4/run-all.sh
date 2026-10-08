#!/usr/bin/env bash
# Runs the P4 checks in order: schema evolution, store ownership, independent restarts.
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/01-schema-evolution.sh"
"$DIR/02-store-ownership.sh"
"$DIR/03-restart-client-api.sh"
"$DIR/04-restart-auth-service.sh"
