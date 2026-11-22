#!/usr/bin/env bash
# Build the six application images.
#   dev (default):  host-arch images tagged bnpb/<svc>:dev, loaded into the kind cluster if present.
#   demo/registry:  PUSH=1 REGISTRY=ghcr.io/<org> TAG=<tag> scripts/m2/build-images.sh
#                   -> multi-arch (linux/amd64,linux/arm64) via buildx, pushed to $REGISTRY/bnpb/<svc>:$TAG
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SERVICES=(aggregator client-api auth-service consumers mock-bmkg mock-pvmbg)
TAG=${TAG:-dev}
KIND_CLUSTER=${KIND_CLUSTER:-bnpb-dev}

if [ "${PUSH:-0}" = "1" ]; then
  : "${REGISTRY:?set REGISTRY, e.g. ghcr.io/<org>}"
  for s in "${SERVICES[@]}"; do
    docker buildx build --platform linux/amd64,linux/arm64 \
      -t "$REGISTRY/bnpb/$s:$TAG" --push "$ROOT/$s"
  done
  exit 0
fi

for s in "${SERVICES[@]}"; do
  docker build -t "bnpb/$s:$TAG" "$ROOT/$s"
done

if command -v kind >/dev/null && kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
  for s in "${SERVICES[@]}"; do
    kind load docker-image "bnpb/$s:$TAG" --name "$KIND_CLUSTER"
  done
fi
