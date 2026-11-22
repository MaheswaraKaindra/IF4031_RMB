#!/usr/bin/env bash
# k3s ships CoreDNS, the local-path provisioner and metrics-server with one replica each. When the node holding it dies, every service-name lookup in the cluster fails until the
# default 300 s eviction toleration passes (measured: Audit API and client-api down for 364 s). Run one replica per node instead;
# the packaged manifest already spreads them across hostnames and sets no replica count, so k3s does not undo this.
set -euo pipefail
REPLICAS=${COREDNS_REPLICAS:-3}
kubectl -n kube-system scale deployment coredns --replicas="$REPLICAS"
kubectl -n kube-system rollout status deployment coredns --timeout=180s
# The provisioner creates every store volume (a replacement node needs it at once) and metrics-server feeds the HPAs; with one
# replica a lost node delays both for the 300 s default eviction toleration. Two replicas keep them available.
for d in local-path-provisioner metrics-server; do
  kubectl -n kube-system scale deployment "$d" --replicas=2
  kubectl -n kube-system rollout status deployment "$d" --timeout=180s
done
kubectl -n kube-system get pods -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName --no-headers | grep -E 'coredns|local-path|metrics-server'
