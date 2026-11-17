#!/usr/bin/env bash
# Install the official Tester Agent UNMODIFIED (pinned manifest commit + image digest from the M2 spec).
# Our namespace must exist first: the manifest creates a Role/RoleBinding inside it.
set -euo pipefail
NS=sistem-informasi-kebencanaan-bnpb
URL=https://raw.githubusercontent.com/susTuna/if4031-tester-agent/ebb55261711123a9a211739ffbf140a275caa6da/manifest.yaml
DIGEST=sha256:b3143da159cf23a8744ede12b847da6208353754234d53a5a7b46d071cf277ec
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

kubectl apply -f "$ROOT/k8s/base/namespace.yaml"
kubectl apply -f "$URL"
kubectl -n tester-agent rollout status daemonset/tester-agent --timeout=180s
got=$(kubectl -n tester-agent get daemonset tester-agent -o jsonpath='{.spec.template.spec.containers[0].image}')
case "$got" in *"$DIGEST") echo "image digest OK";; *) echo "UNEXPECTED tester-agent image: $got" >&2; exit 1;; esac
kubectl -n tester-agent get pods -o wide
echo "practice scenarios: kubectl exec -n tester-agent daemonset/tester-agent -- /app list"
