#!/usr/bin/env bash
# Runs the P4 checks in order: schema evolution, store ownership, independent restarts.
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/p4-01-schema-evolution.sh"
"$DIR/p4-02-store-ownership.sh"
"$DIR/p4-03-restart-client-api.sh"
"$DIR/p4-04-restart-auth-service.sh"
