#!/usr/bin/env bash
# Platform-enforced storage ownership (M2 Platform rule 8) and node-local storage (Tester rule 7).
# Requires a CNI that enforces NetworkPolicy (k3s: yes). Works for the single-Mongo and the sharded layout.
set -euo pipefail
NS=sistem-informasi-kebencanaan-bnpb
fail=0

store_targets=$(kubectl -n "$NS" get svc -l bnpb.io/store=true -o name 2>/dev/null | sed 's#service/##' || true)
[ -n "$store_targets" ] || store_targets=mongo
# Per-member DNS names (headless) are what a bypassing component would try first.
members=$(kubectl -n "$NS" get pods -l bnpb.io/store=true,role=store -o name 2>/dev/null | sed 's#pod/##' | head -3 || true)

can_connect() { # <deployment> <host>
  kubectl -n "$NS" exec "deploy/$1" -- sh -c "nc -z -w 3 $2 27017" >/dev/null 2>&1
}

check() { # <deployment> <host> <expect: allow|deny>
  if can_connect "$1" "$2"; then got=allow; else got=deny; fi
  if [ "$got" = "$3" ]; then echo "ok   $1 -> $2:27017 $got"; else echo "FAIL $1 -> $2:27017 expected $3 got $got"; fail=1; fi
}

for t in $store_targets; do
  check aggregator "$t" allow
  for d in client-api auth-service consumer-notifier consumer-dashboard mock-bmkg; do check "$d" "$t" deny; done
done
for m in $members; do
  host="$m.${m%-0}"
  check aggregator "$host" allow
  check client-api "$host" deny
done

# Storage data must sit on node-local disks: every PV bound to a store pod is hostPath/local, never network storage.
for pvc in $(kubectl -n "$NS" get pvc -o name | sed 's#persistentvolumeclaim/##' | grep -E '^data-(mongo|rabbitmq)' || true); do
  pv=$(kubectl -n "$NS" get pvc "$pvc" -o jsonpath='{.spec.volumeName}')
  kind=$(kubectl get pv "$pv" -o json | jq -r 'if .spec.local then "local" elif .spec.hostPath then "hostPath" else (.spec | keys | map(select(. != "accessModes" and . != "capacity" and . != "claimRef" and . != "persistentVolumeReclaimPolicy" and . != "storageClassName" and . != "volumeMode" and . != "nodeAffinity" and . != "mountOptions")) | join(",")) end')
  node=$(kubectl get pv "$pv" -o json | jq -r '(.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]) // "n/a"')
  case "$kind" in local|hostPath) echo "ok   $pvc on $pv ($kind, node $node)";; *) echo "FAIL $pvc uses non-local volume type '$kind'"; fail=1;; esac
done

[ "$fail" = 0 ] && echo "isolation checks passed" || { echo "isolation checks FAILED" >&2; exit 1; }
