#!/usr/bin/env bash
# P2 criterion 1: the aggregator runs with >= 3 instances on DIFFERENT nodes behind one entry point that only routes to healthy ones.
set -euo pipefail
source "$(dirname "$0")/assert-lib.sh"
MIN=${MIN_REPLICAS:-3}
pods=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o json)
ready=$(jq '[.items[] | select(.metadata.deletionTimestamp==null) | select(any(.status.conditions[]?; .type=="Ready" and .status=="True"))] | length' <<<"$pods")
nodes=$(jq -r '[.items[] | select(.metadata.deletionTimestamp==null) | .spec.nodeName] | unique | length' <<<"$pods")
nodes_total=$(kubectl get nodes --no-headers | wc -l | tr -d ' ')
echo "ready aggregator pods: $ready on $nodes distinct node(s) (cluster has $nodes_total)"
[ "$ready" -ge "$MIN" ] && pass ">= $MIN aggregator instances Ready" || fail "only $ready aggregator instances Ready (need $MIN)"
want=$(( MIN < nodes_total ? MIN : nodes_total ))
[ "$nodes" -ge "$want" ] && pass "instances spread over $nodes different nodes" || fail "instances on only $nodes node(s) (need $want)"
probe=$(kubectl -n "$NS" get deploy aggregator -o jsonpath='{.spec.template.spec.containers[0].readinessProbe.httpGet.path}')
[ -n "$probe" ] && pass "readiness probe on $probe (unhealthy instances leave the Service)" || fail "no readiness probe: unhealthy instances would keep receiving traffic"
# The Service must list exactly the Ready pods' IPs.
for svc in $(kubectl -n "$NS" get svc -o name | grep -E 'aggregator' | sed 's#service/##'); do
  have=$(kubectl -n "$NS" get endpointslices -l "kubernetes.io/service-name=$svc" -o json | jq '[.items[].endpoints[]? | select(.conditions.ready==true)] | length')
  [ "$have" = "$ready" ] && pass "Service $svc routes to $have Ready pods" || fail "Service $svc has $have ready endpoints, $ready pods are Ready"
done
# Through the real entry point every request is answered (a cheap endpoint: the checksum scans every record and takes seconds, which would test the scan and not the routing).
ok=0; for _ in $(seq 1 30); do [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $AUDIT_TOKEN" "$AUDIT_URL/internal/audit/events?limit=1")" = 200 ] && ok=$((ok + 1)); done
[ "$ok" = 30 ] && pass "30/30 requests through NodePort 30000 answered 200" || fail "only $ok/30 requests answered 200"
finish
