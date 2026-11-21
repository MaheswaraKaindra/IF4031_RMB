#!/usr/bin/env bash
# Shared helpers for the P2..P5 cluster checks (source this file). Builds on p1-lib.sh: same NodePort probes and ID helpers.
# Every check prints PASS/FAIL lines; `finish` exits non-zero if any FAIL was printed.
# NODE_IP defaults to the first Ready node, so the checks use the NodePorts (the real entry points) instead of port-forwards.
source "$(dirname "${BASH_SOURCE[0]}")/p1-lib.sh"
if [ -z "${NODE_IP:-}" ]; then
  NODE_IP=$(kubectl get nodes -o json | jq -r '[.items[] | select(any(.status.conditions[]; .type=="Ready" and .status=="True")) | .status.addresses[] | select(.type=="InternalIP") | .address][0]')
  AUDIT_URL=http://$NODE_IP:30000; AUTH_URL=http://$NODE_IP:30090; API_URL=http://$NODE_IP:30080
fi
FAILS=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
check() { # check <description> <command...>: PASS if the command succeeds
  local d=$1; shift; if "$@" >/dev/null 2>&1; then pass "$d"; else fail "$d"; fi
}
finish() { if [ "$FAILS" = 0 ]; then echo "ALL CHECKS PASSED"; else echo "$FAILS CHECK(S) FAILED" >&2; exit 1; fi; }

mint() { # mint <client_id> <client_secret-env-name> -> access token
  curl -s -m 5 -X POST "$AUTH_URL/token" -H 'content-type: application/json' \
    -d "{\"client_id\":\"$1\",\"client_secret\":\"$(envget "$2")\"}" | jq -r '.access_token // empty'
}
# mock_admin <mock-pvmbg|mock-bmkg> <port> <path> <json body>: calls an admin endpoint through a short-lived port-forward
mock_admin() {
  local svc=$1 port=$2 path=$3 body=$4 tok pid out
  case $svc in mock-pvmbg) tok=$(envget PVMBG_TOKEN);; *) tok=$(envget PVMBG_TOKEN);; esac
  kubectl -n "$NS" port-forward "svc/$svc" 18999:"$port" >/dev/null 2>&1 & pid=$!
  for _ in $(seq 1 20); do curl -s -m 1 -o /dev/null "http://127.0.0.1:18999/health" && break; sleep 0.5; done
  out=$(curl -s -m 5 -X POST "http://127.0.0.1:18999$path" -H "Authorization: Bearer $tok" -H 'content-type: application/json' -d "$body")
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null || true
  printf '%s' "$out"
}
wait_for() { # wait_for <seconds> <command...>
  local n=$1; shift; local i; for i in $(seq 1 "$n"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done; return 1
}
all_ready() { # every pod of the app label is Ready and none is terminating
  [ -n "$(ready_pod "$1")" ] && [ "$(kubectl -n "$NS" get pods -l "app.kubernetes.io/name=$1" -o json | jq '[.items[] | select(.metadata.deletionTimestamp==null) | select(any(.status.conditions[]?; .type=="Ready" and .status!="True"))] | length')" = 0 ]
}

# ---- node-level helpers (real VM tests) --------------------------------------------------------------------------------
# VM actions are pluggable so no machine-specific tool path lives in the repo: set VM_STOP_CMD / VM_START_CMD / VM_PAUSE_CMD /
# VM_RESUME_CMD with a {node} placeholder, e.g. VM_STOP_CMD='VBoxManage.exe controlvm {node} poweroff' (the VM is named like
# the node). Without them the script asks you to perform the action by hand and press Enter.
vm_do() { # vm_do <stop|start|pause|resume> <node>
  local var="VM_${1^^}_CMD" cmd; cmd=${!var:-}
  if [ -z "$cmd" ]; then echo ">>> MANUAL: $1 node $2 now, then press Enter"; read -r _; return 0; fi
  eval "${cmd//\{node\}/$2}" >/dev/null
}
node_ip() { kubectl get node "$1" -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}'; }
node_ssh() { # node_ssh <node> <command...>   (SSH_USER defaults to the current user; passwordless sudo is needed for clock tests)
  local n=$1; shift; ssh -o ConnectTimeout=5 -o BatchMode=yes "${SSH_USER:-$(whoami)}@$(node_ip "$n")" "$@"
}
# use_survivor <victim-node>: point kubectl and the NodePort probes at a node that stays up (the default kubeconfig may name the victim)
use_survivor() {
  local victim=$1 surv
  surv=$(kubectl get nodes -o json | jq -r --arg v "$victim" '[.items[] | select(.metadata.name != $v) | select(any(.status.conditions[]; .type=="Ready" and .status=="True")) | .status.addresses[] | select(.type=="InternalIP") | .address][0]')
  SURV_KUBECONFIG=$(mktemp); kubectl config view --minify --raw > "$SURV_KUBECONFIG"
  sed -i "s#server: https://[0-9.]*:#server: https://$surv:#" "$SURV_KUBECONFIG"
  export KUBECONFIG=$SURV_KUBECONFIG
  AUDIT_URL=http://$surv:30000; AUTH_URL=http://$surv:30090; API_URL=http://$surv:30080; NODE_IP=$surv
}
node_ready_wait() { # node_ready_wait <node> <seconds>
  local i; for i in $(seq 1 "$2"); do [ "$(kubectl get node "$1" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ] && return 0; sleep 1; done; return 1
}
lease_holder() { kubectl -n "$NS" get lease "$1" -o jsonpath='{.spec.holderIdentity}' 2>/dev/null; }
lease_transitions() { kubectl -n "$NS" get lease "$1" -o jsonpath='{.spec.leaseTransitions}' 2>/dev/null; }
pod_node() { kubectl -n "$NS" get pod "$1" -o jsonpath='{.spec.nodeName}' 2>/dev/null; }

# ---- leader sampling (P2.4/P2.5) ---------------------------------------------------------------------------------------
# start_leader_sampler <SOURCE> <file>: every 2 s, ask EVERY aggregator pod in parallel whether it is a valid leader of the
# source; one line "<epoch-second> <pod>" per pod that says so. Both pods asked in the same round share the timestamp, so two
# lines with the same timestamp mean two simultaneous valid leaders. Stop with stop_leader_sampler.
LEADER_SAMPLER_PID=""
start_leader_sampler() {
  local source=$1 file=$2
  : > "$file"
  (
    while :; do
      ts=$(date +%s); pids=()
      for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
        ( v=$(kubectl -n "$NS" exec "$p" -c aggregator -- wget -qO- -T 2 http://127.0.0.1:3000/health 2>/dev/null | jq -r --arg s "$source" '.leadership[$s] | select(.isLeader==true and .valid==true) | "1"' 2>/dev/null || true)
          [ "$v" = 1 ] && echo "$ts $p" >> "$file" ) &
        pids+=($!)
      done
      wait "${pids[@]}" 2>/dev/null || true
      sleep 2
    done
  ) >/dev/null 2>&1 &
  LEADER_SAMPLER_PID=$!
}
stop_leader_sampler() { [ -n "$LEADER_SAMPLER_PID" ] && { kill "$LEADER_SAMPLER_PID" 2>/dev/null; pkill -P "$LEADER_SAMPLER_PID" 2>/dev/null || true; }; LEADER_SAMPLER_PID=""; }
# assert_single_leader <file> <min-samples> <what>: PASS only if enough rounds saw a valid leader AND no round saw two
assert_single_leader() {
  local file=$1 min=$2 what=$3 rounds two
  rounds=$(awk '{print $1}' "$file" | sort -u | wc -l | tr -d ' ')
  # two DIFFERENT pods in one round (the same pod listed twice is not a second leader)
  two=$(sort -u "$file" | awk '{c[$1]++} END{n=0; for(k in c) if(c[k]>1) n++; print n}')
  [ "$rounds" -ge "$min" ] && pass "$what: $rounds sampling rounds saw a valid leader (at least $min needed)" || fail "$what: only $rounds sampling rounds saw a valid leader (at least $min needed): the check had too little data"
  if [ "$two" = 0 ]; then pass "$what: never two valid leaders in the same round"
  else
    fail "$what: $two round(s) with two valid leaders at the same time"
    echo "  offending samples (epoch-second pod):" >&2
    sort -u "$file" | awk '{c[$1]++; l[$1]=l[$1] "\n    " $0} END{for(k in c) if(c[k]>1) printf "%s", l[k]; print ""}' >&2
  fi
}
# crash_pod_process <pod> <node>: SIGKILL the Node process of ONE pod from its node (a crash: no SIGTERM handler, no lease release, no cleanup).
# kill -9 from inside the container does nothing (PID 1 of a PID namespace ignores it), and pkill -f would also hit the other Node services on
# the node, so the process is matched by the pod's HOSTNAME in its environment. The container is then restarted by the kubelet.
crash_pod_process() {
  node_ssh "$2" "for pid in \$(pgrep -f 'node dist/index.js'); do sudo tr '\\0' '\\n' < /proc/\$pid/environ 2>/dev/null | grep -qx 'HOSTNAME=$1' && sudo kill -9 \$pid && echo killed \$pid; done"
}
