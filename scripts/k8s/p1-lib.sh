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

# Runs the measurement tool inside the aggregator pod (it owns the storage credentials).
tool() { kubectl -n "$NS" exec deploy/aggregator -- node dist/tools/store-tool.js "$@"; }

PF_PIDS=()
cleanup_pf() { local p; for p in ${PF_PIDS[@]+"${PF_PIDS[@]}"}; do kill "$p" 2>/dev/null || true; done; }
trap cleanup_pf EXIT

wait_http() { # <url>
  local i; for i in $(seq 1 25); do curl -s -m 2 -o /dev/null "$1" && return 0; sleep 1; done
  echo "port-forward for $1 did not come up" >&2; return 1
}

# Audit API (aggregator port 3001, the only published aggregator entry)
start_forward() {
  kubectl -n "$NS" port-forward svc/aggregator-audit "$LOCAL_PORT:3001" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  wait_http "http://127.0.0.1:$LOCAL_PORT/analytics"
}

# Public client path (auth-service + client-api): what a Tim Lapangan / Media client actually experiences
start_client_forward() {
  kubectl -n "$NS" port-forward svc/auth-service "$AUTH_LOCAL:8090" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  kubectl -n "$NS" port-forward svc/client-api "$API_LOCAL:8080" >/dev/null 2>&1 &
  PF_PIDS+=($!)
  wait_http "http://127.0.0.1:$AUTH_LOCAL/health"
  wait_http "http://127.0.0.1:$API_LOCAL/health"
}

# client_events -> "<http_code> <seconds> <complete|partial>"   (a fresh token each call: access tokens live 60s)
client_events() {
  local secret token out code t partial
  secret=$(envget AUTH_CLIENT_FIELD_TEAM_SECRET)
  token=$(curl -s -m 5 -X POST "http://127.0.0.1:$AUTH_LOCAL/token" -H 'content-type: application/json' \
    -d "{\"client_id\":\"field-team\",\"client_secret\":\"$secret\"}" | jq -r '.access_token // empty')
  [ -n "$token" ] || { echo "000 0 no-token"; return; }
  out=$(mktemp)
  read -r code t < <(curl -s -m 10 -o "$out" -w '%{http_code} %{time_total}\n' -H "authorization: Bearer $token" "http://127.0.0.1:$API_LOCAL/events?limit=50" || echo "000 10")
  partial=$(jq -r 'if .partial == true then "partial" else "complete" end' "$out" 2>/dev/null || echo "unparsable")
  rm -f "$out"
  echo "$code $t $partial"
}

# audit <path> -> body on stdout; exit status 0 only for HTTP 200 within 15s
audit() {
  local out code
  out=$(curl -s -m 15 -w '\n%{http_code}' -H "authorization: Bearer $AUDIT_TOKEN" "http://127.0.0.1:$LOCAL_PORT$1") || return 2
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
