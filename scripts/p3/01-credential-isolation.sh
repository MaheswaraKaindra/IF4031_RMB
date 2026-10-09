#!/usr/bin/env bash
# P3 criterion 1: a credential valid for one agency is rejected by the other.
# Expect: BMKG key at PVMBG and PVMBG token at BMKG get 401, no credential gets 401,
# each agency accepts its own credential with 200.
. "$(dirname "$0")/../lib.sh"

step "BMKG key sent to PVMBG, PVMBG token sent to BMKG"
echo "BMKG key at PVMBG (as X-BMKG-Key): HTTP $(code -H "X-BMKG-Key: $X_BMKG_KEY" "$PVMBG_API/volcanic-reports")"
echo "BMKG key at PVMBG (as Bearer): HTTP $(code -H "Authorization: Bearer $X_BMKG_KEY" "$PVMBG_API/volcanic-reports")"
echo "PVMBG token at BMKG (as Bearer): HTTP $(code -H "Authorization: Bearer $PVMBG_TOKEN" "$BMKG_API/seismic-events")"
echo "PVMBG token at BMKG (as X-BMKG-Key): HTTP $(code -H "X-BMKG-Key: $PVMBG_TOKEN" "$BMKG_API/seismic-events")"

step "No credential at all"
echo "BMKG without credential: HTTP $(code "$BMKG_API/seismic-events")"
echo "PVMBG without credential: HTTP $(code "$PVMBG_API/volcanic-reports")"

step "Each agency with its own credential"
echo "BMKG key at BMKG: HTTP $(code -H "X-BMKG-Key: $X_BMKG_KEY" "$BMKG_API/seismic-events")"
echo "PVMBG token at PVMBG: HTTP $(code -H "Authorization: Bearer $PVMBG_TOKEN" "$PVMBG_API/volcanic-reports")"

step "Mock logs: rejected credentials"
docker compose logs --since 1m mock-bmkg mock-pvmbg | grep 'credential rejected' | tail -4
