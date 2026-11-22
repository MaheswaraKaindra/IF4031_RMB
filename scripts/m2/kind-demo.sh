#!/usr/bin/env bash
# Rehearse the DEMO overlay on a laptop with kind (3 workers = 3 store slots). Shared kernel: NOT valid M2 evidence.
#   scripts/m2/kind-demo.sh            create cluster, preload every image from the host, label slots, deploy demo
# Images are loaded from the host Docker (kind's own pulls are unreliable on some networks); missing ones are pulled first.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CLUSTER=${KIND_CLUSTER:-bnpb-demo}
REGISTRY=${REGISTRY:-kind.local}
SERVICES=(aggregator client-api auth-service consumers mock-bmkg mock-pvmbg)

kind get clusters 2>/dev/null | grep -qx "$CLUSTER" || kind create cluster --name "$CLUSTER" --config "$ROOT/k8s/overlays/dev/kind-demo-cluster.yaml"
kubectl config use-context "kind-$CLUSTER" >/dev/null

load() { # <image>: host image -> every kind node (single-platform archive; `kind load docker-image` fails on multi-arch stores)
  local tar; tar=$(mktemp)
  docker save --platform "linux/$(docker version -f '{{.Server.Arch}}')" "$1" -o "$tar" 2>/dev/null || docker save "$1" -o "$tar"
  kind load image-archive "$tar" --name "$CLUSTER" >/dev/null; rm -f "$tar"
}

for s in "${SERVICES[@]}"; do
  docker build -q -t "$REGISTRY/bnpb/$s:demo" "$ROOT/$s" >/dev/null
  load "$REGISTRY/bnpb/$s:demo"
done
# Digest-pinned images are skipped: the kubelet pulls them itself (a loaded copy breaks the digest lookup).
for img in $(kubectl kustomize "$ROOT/k8s/overlays/demo" | grep -oE 'image: [^ ]+' | cut -d' ' -f2 | grep -v -e REGISTRY_PLACEHOLDER -e '@sha256:' | sort -u); do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  load "$img"
done

workers=$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o name | sed 's#node/##')
# shellcheck disable=SC2086
"$ROOT/scripts/m2/label-nodes.sh" $workers
REGISTRY=$REGISTRY "$ROOT/scripts/m2/deploy.sh" demo
