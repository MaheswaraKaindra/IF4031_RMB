#!/usr/bin/env bash
# Shared helpers for the P1 evidence scripts (source this file).
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
NS=${NAMESPACE:-sistem-informasi-kebencanaan-bnpb}
ENV_FILE=${ENV_FILE:-$ROOT/.env}
LOCAL_PORT=${LOCAL_PORT:-13000}
AUTH_LOCAL=${AUTH_LOCAL:-18090}
API_LOCAL=${API_LOCAL:-18080}
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

envget() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2-; }
AUDIT_TOKEN=$(envget AUDIT_TOKEN)
[ -n "$AUDIT_TOKEN" ] || { echo "AUDIT_TOKEN missing in $ENV_FILE" >&2; exit 1; }

# Runs the measurement tool inside a Ready aggregator pod (it owns the storage credentials); `exec deploy/...` may pick
# a pod stuck on a dead node.
tool() {
  local pod; pod=$(ready_pod aggregator)
  [ -n "$pod" ] || { echo "no Ready aggregator pod" >&2; return 1; }
  kubectl -n "$NS" exec "$pod" -c aggregator -- node dist/tools/store-tool.js "$@"
}

# Where requests go. Default: kubectl port-forwards (see forward() below).
# On the real cluster prefer the NodePorts of a node OUTSIDE the slot under test, so the probe path itself survives:
#   NODE_IP=192.168.56.11 scripts/k8s/p1-node-loss.sh 2 --manual
NODE_IP=${NODE_IP:-}
if [ -n "$NODE_IP" ]; then
  AUDIT_URL=${AUDIT_URL:-http://$NODE_IP:30000}; AUTH_URL=${AUTH_URL:-http://$NODE_IP:30090}; API_URL=${API_URL:-http://$NODE_IP:30080}
fi
AUDIT_URL=${AUDIT_URL:-}; AUTH_URL=${AUTH_URL:-}; API_URL=${API_URL:-}

PF_PIDS=()
cleanup_pf() { local p; for p in ${PF_PIDS[@]+"${PF_PIDS[@]}"}; do pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; }
trap cleanup_pf EXIT

wait_http() { # <url>
  local i; for i in $(seq 1 25); do curl -s -m 2 -o /dev/null "$1" && return 0; sleep 1; done
  echo "endpoint $1 did not come up" >&2; return 1
}

# ready_pod <app label>: a Ready pod that is not being deleted (a pod on a dead node stays "Terminating" for good)
ready_pod() {
  kubectl -n "$NS" get pods -l "app.kubernetes.io/name=$1" -o json | jq -r '[.items[]
    | select(.metadata.deletionTimestamp == null)
    | select(any(.status.conditions[]?; .type == "Ready" and .status == "True"))][0].metadata.name // empty'
}
pod_ready() { [ "$(kubectl -n "$NS" get pod "$1" -o jsonpath='{.metadata.deletionTimestamp}|{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = "|True" ]; }

# forward <app label> <local-port> <remote-port>: a port-forward pins ONE pod and is NOT closed when that pod's node dies,
# so forward to an explicitly chosen Ready pod and move to another one as soon as it stops being Ready (the same moment a
# Service drops the endpoint).
forward() {
  ( set +e   # the callers run under `set -e`: a failed kill/wait of the old forward must not end this loop
    while :; do
      pod=$(ready_pod "$1")
      if [ -z "$pod" ]; then sleep 2; continue; fi
      kubectl -n "$NS" port-forward "pod/$pod" "$2:$3" >/dev/null 2>&1 & fpid=$!
      while kill -0 "$fpid" 2>/dev/null && pod_ready "$pod"; do sleep 2; done
      kill "$fpid" 2>/dev/null; wait "$fpid" 2>/dev/null
    done ) 2>/dev/null &
  PF_PIDS+=($!)
}

# Audit API (aggregator port 3001, the only published aggregator entry)
start_forward() {
  if [ -z "$AUDIT_URL" ]; then forward aggregator "$LOCAL_PORT" 3001; AUDIT_URL=http://127.0.0.1:$LOCAL_PORT; fi
  wait_http "$AUDIT_URL/analytics"
}

# Public client path (auth-service + client-api): what a Tim Lapangan / Media client actually experiences
start_client_forward() {
  if [ -z "$AUTH_URL" ]; then forward auth-service "$AUTH_LOCAL" 8090; AUTH_URL=http://127.0.0.1:$AUTH_LOCAL; fi
  if [ -z "$API_URL" ]; then forward client-api "$API_LOCAL" 8080; API_URL=http://127.0.0.1:$API_LOCAL; fi
  wait_http "$AUTH_URL/health"
  wait_http "$API_URL/health"
}

# client_events -> "<http_code> <seconds> <complete|partial>"   (a fresh token each call: access tokens live 60s)
client_events() {
  local secret token out code t partial
  secret=$(envget AUTH_CLIENT_FIELD_TEAM_SECRET)
  token=$(curl -s -m 5 -X POST "$AUTH_URL/token" -H 'content-type: application/json' \
    -d "{\"client_id\":\"field-team\",\"client_secret\":\"$secret\"}" | jq -r '.access_token // empty')
  [ -n "$token" ] || { echo "000 0 no-token"; return; }
  out=$(mktemp)
  read -r code t < <(curl -s -m 10 -o "$out" -w '%{http_code} %{time_total}\n' -H "authorization: Bearer $token" "$API_URL/events?limit=50" || echo "000 10")
  partial=$(jq -r 'if .partial == true then "partial" else "complete" end' "$out" 2>/dev/null || echo "unparsable")
  rm -f "$out"
  echo "$code $t $partial"
}

# audit <path> -> body on stdout; exit status 0 only for HTTP 200 within 15s
audit() {
  local out code
  out=$(curl -s -m 15 -w '\n%{http_code}' -H "authorization: Bearer $AUDIT_TOKEN" "$AUDIT_URL$1") || return 2
  code=${out##*$'\n'}
  printf '%s' "${out%$'\n'*}"
  [ "$code" = 200 ]
}

# snapshot <file>: per-source count + checksum (Appendix A). EVIDENCE only: live writers change it between runs.
snapshot() {
  local f=$1; : > "$f"
  local s
  for s in BMKG PVMBG SATELIT SENSOR_PANTAI; do
    audit "/internal/audit/checksum?source=$s" | jq -c '{source, count, checksum, partial}' >> "$f"
  done
}

# collect_ids <file>: sorted unique "source|source_ref_id" of every stored record, via the Audit API.
# The PASS criterion for "no HazardEvent lost" is CONTAINMENT (before is a subset of after): the mocks and pollers keep
# adding events during the test, so checksum equality would fail on healthy runs.
collect_ids() {  # retries for up to ~2 min: right after a restore the answer can stay partial until the election/probe settle
  local f=$1 n
  for n in $(seq 1 24); do collect_ids_once "$f" && return 0; sleep 5; done
  echo "collect_ids: still partial/failing after 2 min" >&2; return 1
}
collect_ids_once() {
  local f=$1 cursor="" body expected
  # Records only ever get added while this runs, so a complete listing can never be SHORTER than this count.
  expected=$(audit "/internal/audit/checksum" | jq -r 'if .partial then empty else .count end') || return 1
  [ -n "$expected" ] || return 1
  : > "$f.raw"
  while :; do
    body=$(audit "/internal/audit/events?limit=1000${cursor:+&cursor=$cursor}") || return 1
    [ "$(jq -r '.partial' <<<"$body")" = false ] || return 1
    jq -r '.items[] | "\(.source)|\(.source_ref_id)"' <<<"$body" >> "$f.raw"
    cursor=$(jq -r '.next_cursor // empty' <<<"$body")
    [ -z "$cursor" ] && break
  done
  LC_ALL=C sort -u "$f.raw" > "$f"; rm -f "$f.raw"
  if [ "$(wc -l < "$f" | tr -d ' ')" -lt "$expected" ]; then
    echo "collect_ids: listing has $(wc -l < "$f" | tr -d ' ') records but the store reported $expected; retrying" >&2; return 1
  fi
}

members_json() { tool report | jq -c 'select(has("member"))' | jq -s '.'; }

# Redundancy restored = every shard has 2 reachable data members holding the same number of records (within TOL).
redundancy_ok() {
  members_json | jq -e '
    group_by(.unit) | all(length == 2 and all(.[]; .count != null and .role != "down") and ((.[0].count - .[1].count) | fabs) <= (env.TOL // "0" | tonumber))' >/dev/null
}

# layout helpers
layout() { cat "$ROOT/k8s/store/layout.json"; }
members_of_slot() { layout | jq -r --argjson s "$1" '[.config.members[], (.shards[].members[])] | .[] | select(.slot == $s) | .name'; }
data_members_of_shard() { layout | jq -r --arg u "shard-$1" '.shards[] | select(.name == $u) | .members[] | select(.arbiter | not) | .name'; }

# wipe_members <snapshot-dir> <member...>: stop them, delete their PVCs (waiting until really gone) = permanent loss of data.
wipe_members() {
  local dir=$1; shift
  local m
  for m in "$@"; do
    kubectl -n "$NS" get pvc "data-$m-0" -o jsonpath='{.metadata.uid}' > "$dir/uid-$m" 2>/dev/null || true
    kubectl -n "$NS" scale statefulset "$m" --replicas=0 >/dev/null
  done
  for m in "$@"; do
    kubectl -n "$NS" wait --for=delete "pod/$m-0" --timeout=180s >/dev/null 2>&1 || true
    kubectl -n "$NS" delete pvc "data-$m-0" --wait=false >/dev/null 2>&1 || true
    kubectl -n "$NS" wait --for=delete "pvc/data-$m-0" --timeout=180s >/dev/null 2>&1 || true
  done
}

# restore_members <snapshot-dir> <wiped: 1|0> <member...>: bring them back; when wiped, assert the volume is a NEW one.
restore_members() {
  local dir=$1 wiped=$2; shift 2
  local m old new i
  for m in "$@"; do kubectl -n "$NS" scale statefulset "$m" --replicas=1 >/dev/null; done
  [ "$wiped" = 1 ] || return 0
  for m in "$@"; do
    old=$(cat "$dir/uid-$m" 2>/dev/null || true); new=""
    for i in $(seq 1 30); do
      new=$(kubectl -n "$NS" get pvc "data-$m-0" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
      [ -n "$new" ] && break; sleep 2
    done
    if [ -n "$old" ] && [ "$old" = "$new" ]; then echo "FAIL: $m re-used its OLD volume (uid $old): the disk was not really wiped" >&2; return 1; fi
    echo "member $m restarted on a fresh, empty volume (pvc uid ${old:-none} -> $new)"
  done
}
