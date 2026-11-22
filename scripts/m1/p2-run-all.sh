#!/usr/bin/env bash
# Runs the P2 checks in order. The load tests take about 60 s each, so they are opt-in:
#   ./scripts/m1/p2-run-all.sh              baseline, outage, delay proof, Aggregator down, correlation ID
#   ./scripts/m1/p2-run-all.sh --with-load  the same plus the three load tests (needs PVMBG delay 3000 in .env)
DIR="$(cd "$(dirname "$0")" && pwd)"

"$DIR/p2-01-baseline.sh"
"$DIR/p2-02-outage.sh"
"$DIR/p2-03-delay-proof.sh"
"$DIR/p2-07-aggregator-down.sh"
"$DIR/p2-08-correlation-id.sh"

if [ "${1:-}" = "--with-load" ]; then
    "$DIR/p2-04-load-delay3s.sh"
    "$DIR/p2-05-load-outage.sh"
    "$DIR/p2-06-load-429.sh"
fi
