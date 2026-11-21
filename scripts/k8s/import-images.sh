#!/usr/bin/env bash
# Registry-less demo: build the six application images and import them straight into k3s on every VM over SSH.
#   scripts/k8s/import-images.sh <ssh-host> [<ssh-host>...]      e.g. ubuntu@192.168.56.11 ubuntu@192.168.56.12 ...
#   then: REGISTRY=local.import scripts/deploy.sh demo
# Env: ARCH (default amd64, the VMs' CPU), REGISTRY (default local.import, only a name: nothing is pushed), TAG (demo).
# The SSH user needs passwordless sudo for `k3s ctr`. Third-party images (mongo, rabbitmq, ...) are still pulled by k3s.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: $0 <ssh-host> [<ssh-host>...]" >&2; exit 1; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SERVICES=(aggregator client-api auth-service consumers mock-bmkg mock-pvmbg)
# ONLY="aggregator client-api" imports just those images (the rest stay as they are on the nodes).
[ -z "${ONLY:-}" ] || read -r -a SERVICES <<< "$ONLY"
ARCH=${ARCH:-amd64}
REGISTRY=${REGISTRY:-local.import}
TAG=${TAG:-demo}
TAR=$(mktemp -d)/bnpb-images.tar
trap 'rm -rf "$(dirname "$TAR")"' EXIT

imgs=()
for s in "${SERVICES[@]}"; do
  img="$REGISTRY/bnpb/$s:$TAG"
  if docker buildx version >/dev/null 2>&1; then
    docker buildx build --platform "linux/$ARCH" --load -t "$img" "$ROOT/$s"
  else
    docker build --platform "linux/$ARCH" -t "$img" "$ROOT/$s"   # no buildx plugin: the classic builder is enough for the host architecture
  fi
  imgs+=("$img")
done
docker save --platform "linux/$ARCH" "${imgs[@]}" -o "$TAR" 2>/dev/null || docker save "${imgs[@]}" -o "$TAR"
echo "archive: $(du -h "$TAR" | cut -f1)"

for h in "$@"; do
  echo ">>> $h"
  ssh "$h" 'sudo k3s ctr images import -' < "$TAR"
  ssh "$h" "sudo k3s ctr images ls -q | grep -c '^$REGISTRY/bnpb/'" | sed 's/^/    images present: /'
done
echo "next: REGISTRY=$REGISTRY scripts/deploy.sh demo"
