#!/usr/bin/env bash
# Assert every pod in the namespace has a valid role label and Appendix B memory requests/limits.
# Usage: scripts/m2/verify-resources.sh            (live cluster)
#        scripts/m2/verify-resources.sh --manifests k8s/overlays/dev   (static check of rendered manifests)
set -euo pipefail

NS=sistem-informasi-kebencanaan-bnpb
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# Appendix B (memory request/limit) by role. sensor and other fall under "Komponen lain".
TABLE='{
  "aggregator": ["256Mi","512Mi"], "store": ["512Mi","1Gi"], "broker": ["512Mi","1Gi"],
  "consumer": ["128Mi","256Mi"], "api": ["128Mi","256Mi"], "mock": ["64Mi","128Mi"],
  "sensor": ["128Mi","256Mi"], "other": ["128Mi","256Mi"]
}'

if [ "${1:-}" = "--manifests" ]; then
  # Rendered workloads: check the pod template instead of running pods.
  DOC=$(kubectl kustomize "${2:?overlay dir}" | python3 -c '
import sys, json, yaml
print(json.dumps([d for d in yaml.safe_load_all(sys.stdin) if d]))' 2>/dev/null) \
    || { echo "static mode needs python3 with PyYAML" >&2; exit 1; }
  PODS=$(jq -c '[.[] | select(.kind=="Deployment" or .kind=="StatefulSet" or .kind=="DaemonSet" or .kind=="Job")
                 | {name: .metadata.name, labels: .spec.template.metadata.labels, spec: .spec.template.spec}]' <<<"$DOC")
else
  PODS=$(kubectl -n "$NS" get pods -o json \
    | jq -c '[.items[] | {name: .metadata.name, labels: .metadata.labels, spec: .spec}]')
fi

jq -r --argjson t "$TABLE" '
  .[] | . as $p
  | ($p.labels.role // "") as $role
  | if ($t[$role] == null) then "FAIL \($p.name): role label \"\($role)\" is missing or invalid"
    else ($p.spec.containers + ($p.spec.initContainers // []))[]
      | (.resources.requests.memory // "none") as $req
      | (.resources.limits.memory // "none") as $lim
      | if $req == $t[$role][0] and $lim == $t[$role][1]
        then "ok   \($p.name)/\(.name) role=\($role) \($req)/\($lim)"
        else "FAIL \($p.name)/\(.name) role=\($role) has \($req)/\($lim), expected \($t[$role][0])/\($t[$role][1])" end
    end' <<<"$PODS" | tee /dev/stderr | { ! grep -q '^FAIL'; }
echo "all resource and role checks passed"
