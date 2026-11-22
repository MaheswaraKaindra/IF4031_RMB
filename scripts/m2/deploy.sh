#!/usr/bin/env bash
# One-command deploy of the whole BNPB system.
#   scripts/m2/deploy.sh dev                 kind smoke cluster on a laptop (builds images, creates the cluster if needed)
#   REGISTRY=<registry> scripts/m2/deploy.sh demo
#                                         final layout on the cluster selected by the current kubectl context:
#                                         sharded store, sensor, observability. Prerequisites:
#                                           1. nodes labelled:  scripts/m2/label-nodes.sh <n1> <n2> <n3>
#                                           2. images pushed:   PUSH=1 REGISTRY=<registry> TAG=demo scripts/m2/build-images.sh
#   scripts/m2/deploy.sh <other-overlay>     any k8s/overlays/<name>
# Also: INSTALL_TESTER=1 installs the official Tester Agent afterwards.
# Prerequisite: .env with credentials (cp .env.example .env && ./scripts/m1/gen-secrets.sh >> .env)
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OVERLAY=${1:-dev}
NS=sistem-informasi-kebencanaan-bnpb
KIND_CLUSTER=${KIND_CLUSTER:-bnpb-dev}
export STORE_MODE=single
[ "$OVERLAY" = demo ] && STORE_MODE=sharded

[ -d "$ROOT/k8s/overlays/$OVERLAY" ] || { echo "unknown overlay: $OVERLAY" >&2; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl is required" >&2; exit 1; }
if [ "$OVERLAY" = demo ]; then
  : "${REGISTRY:?set REGISTRY (images must already be pushed there with TAG=demo)}"
fi

if [ "$OVERLAY" = dev ]; then
  command -v kind >/dev/null || { echo "kind is required for the dev overlay" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "Docker daemon is not running (start Docker Desktop)" >&2; exit 1; }
  if ! kind get clusters 2>/dev/null | grep -qx "$KIND_CLUSTER"; then
    kind create cluster --name "$KIND_CLUSTER" --config "$ROOT/k8s/overlays/dev/kind-cluster.yaml"
  fi
  kubectl config use-context "kind-$KIND_CLUSTER" >/dev/null
  "$ROOT/scripts/m2/build-images.sh"
fi

echo "context: $(kubectl config current-context)  overlay: $OVERLAY  store: $STORE_MODE"
kubectl apply -f "$ROOT/k8s/base/namespace.yaml"
[ "$OVERLAY" = demo ] && "$ROOT/scripts/m2/harden-platform.sh"
"$ROOT/scripts/m2/create-secrets.sh"
[ "$STORE_MODE" = sharded ] && "$ROOT/scripts/m2/store-topology.sh"
# Jobs are immutable: drop the previous bootstrap Job so a changed script re-runs (the script itself is idempotent).
kubectl -n "$NS" delete job store-init --ignore-not-found >/dev/null

kubectl kustomize "$ROOT/k8s/overlays/$OVERLAY" | sed "s#REGISTRY_PLACEHOLDER#${REGISTRY:-}#g" | kubectl apply -f -

if [ "$STORE_MODE" = sharded ]; then
  echo "waiting for the store bootstrap Job (replica sets, shards, users)..."
  kubectl -n "$NS" wait --for=condition=complete job/store-init --timeout=900s
fi
for kind_name in $(kubectl -n "$NS" get deploy,statefulset -o name); do
  kubectl -n "$NS" rollout status "$kind_name" --timeout=600s
done
[ "${INSTALL_TESTER:-0}" = 1 ] && "$ROOT/scripts/m2/install-tester-agent.sh"
echo "deployed overlay '$OVERLAY' to namespace $NS"
echo "verify: scripts/m2/verify-resources.sh && scripts/m2/smoke.sh$([ "$STORE_MODE" = sharded ] && echo ' && scripts/m2/verify-isolation.sh')"
