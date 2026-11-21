#!/usr/bin/env bash
# k3s ships CoreDNS with one replica. When the node holding it dies, every service-name lookup in the cluster fails until the
# default 300 s eviction toleration passes (measured: Audit API and client-api down for 364 s). Run one replica per node instead;
# the packaged manifest already spreads them across hostnames and sets no replica count, so k3s does not undo this.
set -euo pipefail
REPLICAS=${COREDNS_REPLICAS:-3}
kubectl -n kube-system scale deployment coredns --replicas="$REPLICAS"
kubectl -n kube-system rollout status deployment coredns --timeout=180s
kubectl -n kube-system get pods -l k8s-app=kube-dns -o custom-columns=POD:.metadata.name,NODE:.spec.nodeName --no-headers
