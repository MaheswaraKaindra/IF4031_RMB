#!/usr/bin/env bash
# Takes the proofs for the report, one item at a time, in the order of docs/m2/proof-plan.md.
#   scripts/m2/proof.sh list            all item ids with a one-line description (and which ones break something on purpose)
#   scripts/m2/proof.sh 1.2             one item
#   scripts/m2/proof.sh p1              a whole group in order (p1 p2 p3 p4 p5 g), asking before each item
# For every item the script: checks the cluster is healthy (for items that disturb it), runs the test through proof-run.sh (output shown live and saved to
# docs/m2/proofs/<id>/), then asks you to take the screenshot (Win+PrintScreen) and imports it with shot.sh. Items that need a browser tell you what to open.
# Nothing is committed or pushed. A failed run still keeps its text file: read it, then run the item again if it was a harness problem.
set -uo pipefail
SELF=$(cd "$(dirname "$0")" && pwd)/$(basename "$0"); ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
export PATH="$PATH:$HOME/.local/bin"
export SSH_USER=${SSH_USER:-vboxuser} NODE_IP=${NODE_IP:-192.168.56.11}
VB='/mnt/c/Program Files/Oracle/VirtualBox/VBoxManage.exe'
export VM_STOP_CMD="'$VB' controlvm {node} poweroff" VM_START_CMD="'$VB' startvm {node} --type headless" VM_PAUSE_CMD="'$VB' controlvm {node} pause" VM_RESUME_CMD="'$VB' controlvm {node} resume"
source scripts/m2/assert-lib.sh >/dev/null 2>&1 || { echo "cannot load assert-lib.sh (is .env present?)" >&2; exit 1; }
set +e +u   # assert-lib may enable them
PF=()

rp() { local id=$1; shift; scripts/m2/proof-run.sh "$id" "$@"; }                      # run one command as a proof (ARTIFICIAL=... in front adds the explanation)
shots() { # shots <id> [label] [what]
  local id=$1 label=${2:-shot} what=${3:-the terminal with the command at the top and the result below}
  echo; echo ">>> SCREENSHOT for $id: $what"
  read -r -p "    take it now (Win+PrintScreen), then press Enter to import it (s = skip): " a
  [ "$a" = s ] || scripts/m2/shot.sh "$id" "$label"
}
# After the clock, freeze and failover items a VM can still have a wrong clock for a while. A client-api pod on such a node sees every access token (valid 60 s) as expired early
# and answers 401 (measured: a node about 28 s off made 906 of 24,765 requests fail in the 10,000-user run). So every VM must be within 5 s of this machine before an item starts.
clocks_ok() {
  local i ip off bad
  for i in $(seq 1 12); do
    bad=""
    for ip in 192.168.56.11 192.168.56.13 192.168.56.14; do
      off=$(ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=no "$SSH_USER@$ip" 'date +%s' 2>/dev/null); off=$(( ${off:-0} - $(date +%s) )); [ "${off#-}" -le 5 ] || bad="$bad $ip(${off}s)"
    done
    [ -z "$bad" ] && { echo ">>> VM clocks are within 5 s of this machine"; return 0; }
    echo ">>> clock offset too large on:$bad ; asking the VMs to resync (try $i of 12)"
    for ip in 192.168.56.11 192.168.56.13 192.168.56.14; do ssh -o ConnectTimeout=6 -o StrictHostKeyChecking=no "$SSH_USER@$ip" 'sudo systemctl restart systemd-timesyncd 2>/dev/null; sudo chronyc makestep >/dev/null 2>&1; true' >/dev/null 2>&1; done
    sleep 15
  done
  echo "STOP: a VM clock is still more than 5 s off ($bad). Fix it (timedatectl) and run this item again." >&2; return 1
}
need_healthy() {
  echo ">>> checking that the cluster is healthy before this test"
  local n bad i ok=0
  for i in $(seq 1 60); do
    n=$(kubectl get nodes --no-headers 2>/dev/null | grep -c ' Ready'); bad=$(kubectl -n "$NS" get pods --no-headers 2>/dev/null | grep -vc ' 1/1 \| Completed')
    [ "$n" = 3 ] && [ "$bad" = 0 ] && redundancy_ok && { ok=1; break; }; sleep 10
  done
  [ "$ok" = 1 ] || { echo "STOP: the cluster is not healthy (3 Ready nodes, all pods Ready, store redundant). Wait or ask for help, then run this item again." >&2; return 1; }
  clocks_ok || return 1
  echo ">>> healthy; waiting for 2 quiet minutes (no write-concern timeouts)"
  for i in $(seq 1 30); do
    local c=0 p; for p in $(kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o name); do c=$((c + $(kubectl -n "$NS" logs "$p" -c aggregator --since=120s 2>/dev/null | grep -c wtimeout))); done
    [ "$c" = 0 ] && { echo ">>> quiet"; return 0; }; sleep 10
  done
  echo "STOP: the store is still timing out writes; wait and run this item again." >&2; return 1
}
ui_forwards() { # port-forward Grafana (3000) and Jaeger (16686) for the browser; stopped by ui_stop
  kubectl -n "$NS" port-forward svc/grafana 3000:3000 >/dev/null 2>&1 & PF+=($!)
  kubectl -n "$NS" port-forward svc/jaeger 16686:16686 >/dev/null 2>&1 & PF+=($!)
  sleep 3; echo ">>> in your browser: Grafana http://localhost:3000 (no login)   Jaeger http://localhost:16686"
}
ui_stop() { local p; for p in "${PF[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done; PF=(); }
trap ui_stop EXIT
envf() { grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2-; }

# ---- internal helpers (called through proof-run.sh so that no secret appears in the saved command line) ----
internal() {
  case "$1" in
  _pods) scripts/m2/p2-placement.sh; local rc=$?; echo; kubectl -n "$NS" get pods -l app.kubernetes.io/name=aggregator -o wide; return $rc ;;
  _reference)
    MP=$(kubectl -n "$NS" get pods -l app.kubernetes.io/name=mongos -o jsonpath='{.items[0].metadata.name}'); kubectl -n "$NS" port-forward "pod/$MP" 27018:27017 >/dev/null 2>&1 & local pf=$!; sleep 3
    export MONGO_URI="mongodb://aggregator:$(envf MONGO_APP_PASSWORD)@127.0.0.1:27018/?authSource=admin"
    ( cd aggregator && node --import tsx src/tools/satellite-tool.ts reference --db bnpb_canonical_store ); kill "$pf" 2>/dev/null ;;
  _late) ( cd aggregator && node --import tsx --test src/satellite/clustering/fireIndex.test.ts src/satellite/processing/processor.test.ts src/satellite/processing/runner.test.ts 2>&1 | grep -E "^# (tests|pass|fail)|ok [0-9]+ -.*(late|Late|lateness|retract|update)" ) ;;
  _live)
    local p; p=$(lease_holder aggregator-satellite); echo "satellite leader: $p"
    for k in 1 2 3; do echo "--- $(date -u +%T)"; kubectl -n "$NS" exec "$p" -c aggregator -- wget -qO- -T 3 http://127.0.0.1:3000/metrics 2>/dev/null | grep -E "^satellite_(feed_speed|source_latest_offset|committed_offset|source_offset_lag|active_fires|late_detections|fires_written_total)"; sleep 60; done ;;
  _priority)
    local fs ms; fs=$(envf AUTH_CLIENT_FIELD_TEAM_SECRET); ms=$(envf AUTH_CLIENT_MEDIA_SECRET)
    k6 run --quiet -e FIELD_SECRET="$fs" -e MEDIA_SECRET="$ms" -e BASE_URL="$API_URL" -e AUTH_URL="$AUTH_URL" -e MEDIA_VUS="${MEDIA_VUS:-40}" -e FIELD_VUS="${FIELD_VUS:-5}" -e POST_VUS="${POST_VUS:-2}" -e DURATION=40s "$ROOT/load-test/p5-priority.js" 2>&1 | grep -E "✓|✗|accepted_field|refused_field|rejected_|served_|client:field_team|client:media|http_req_duration|THRESHOLD|threshold" ;;
  _trace)
    kubectl -n "$NS" port-forward svc/jaeger 16688:16686 >/dev/null 2>&1 & local pf=$!; sleep 3
    local tok id tp; tok=$(curl -s -m 5 -X POST "$AUTH_URL/token" -H 'content-type: application/json' -d "{\"client_id\":\"field-team\",\"client_secret\":\"$(envf AUTH_CLIENT_FIELD_TEAM_SECRET)\"}" | jq -r .access_token)
    id="proof-$(date +%s)"; tp=$(curl -s -m 10 -D - -o /dev/null -X POST "$API_URL/field-reports" -H "authorization: Bearer $tok" -H 'content-type: application/json' -H "x-correlation-id: $id" \
      -d "{\"report_id\":\"$id\",\"hazard_type\":\"COASTAL\",\"severity\":\"AWAS\",\"area_name\":\"Padang\",\"latitude\":-0.95,\"longitude\":100.35,\"occurred_at\":\"$(date -u +%FT%TZ)\"}" | tr -d '\r' | awk -F': ' 'tolower($1)=="traceparent"{print $2}')
    echo "correlation id: $id   traceparent: $tp"; sleep 10; python3 "$ROOT/scripts/m2/trace-table.py" "http://127.0.0.1:16688" "$(echo "$tp" | cut -d- -f2)"; kill "$pf" 2>/dev/null ;;
  _trace_coastal)
    kubectl -n "$NS" port-forward svc/jaeger 16688:16686 >/dev/null 2>&1 & local pf=$!; sleep 3
    python3 "$ROOT/scripts/m2/trace-table.py" "http://127.0.0.1:16688" "" "aggregator" "coastal critical ingest"; kill "$pf" 2>/dev/null ;;
  _logline)
    local tok id; tok=$(curl -s -m 5 -X POST "$AUTH_URL/token" -H 'content-type: application/json' -d "{\"client_id\":\"field-team\",\"client_secret\":\"$(envf AUTH_CLIENT_FIELD_TEAM_SECRET)\"}" | jq -r .access_token)
    id="proof-log-$(date +%s)"; echo "request: GET /events?limit=5 with x-correlation-id: $id"
    curl -s -m 10 -o /dev/null -w 'answer: HTTP %{http_code}\n' "$API_URL/events?limit=5" -H "authorization: Bearer $tok" -H "x-correlation-id: $id"
    # the log lines reach `kubectl logs` a few seconds after the request: wait until both services show the id (up to 40 s)
    for _ in $(seq 1 20); do n=0; for d in client-api aggregator; do kubectl -n "$NS" logs -l app.kubernetes.io/name=$d --since=2m --max-log-requests=20 --tail=-1 2>/dev/null | grep -q "$id" && n=$((n + 1)); done; [ "$n" = 2 ] && break; sleep 2; done
    for d in client-api aggregator; do echo "--- log lines of $d with that correlation id (all pods)"; kubectl -n "$NS" logs -l app.kubernetes.io/name=$d --since=2m --max-log-requests=20 --tail=-1 2>/dev/null | grep "$id" | head -4 | cut -c1-300; done ;;
  esac
}

# ---- items ----
item_1_1() { rp 1.1 scripts/m2/p1-report.sh; shots 1.1; }
item_1_2() { ARTIFICIAL="simulated catalog and a simulated regional burst (20,000 writes in Sumatera Barat)" rp 1.2 scripts/m2/p1-hotspot.sh 20000 sumatra; shots 1.2; }
item_1_3() { rp 1.3 scripts/m2/p1-query.sh; shots 1.3; }
item_1_4() {
  need_healthy || return 1
  ARTIFICIAL="the node loss is simulated: every store member of slot 3 is stopped and its volume erased, then it restarts on an empty volume" rp 1.4 scripts/m2/p1-node-loss.sh 3; shots 1.4 shot "the start (command and 'before') and, if needed, a second shot of the end (lost=0, PASS lines)"
  need_healthy || return 1
  ARTIFICIAL="a whole shard (both data members) is made unreachable, its data stays on disk" rp 1.4-partial scripts/m2/p1-unit-loss.sh 1; shots 1.4-partial shot "the partial answers and the final PASS lines"
}
item_1_5() { need_healthy || return 1; rp 1.5 scripts/m2/p1-write-probe.sh 270 "scripts/m2/p1-node-loss.sh 3"; shots 1.5 shot "the write results (all answered 202) and the PASS lines"; }
item_1_6() { need_healthy || return 1; ARTIFICIAL="the second node loss is simulated the same way (slot 2) after slot 3 has re-synced" rp 1.6 scripts/m2/p1-node-loss.sh 2; shots 1.6; }
item_1_7() {
  cat <<EOF

>>> 1.7 needs your browser (the analytics dashboard)
    1. Open  http://$NODE_IP:30000/analytics
    2. Paste the audit token (the AUDIT_TOKEN line in .env), keep Rentang "24 jam", click Muat.
       SCREENSHOT: the green "Data lengkap" banner with the chart and tables. Then click "Cocokkan dengan Audit API" and screenshot the result.
EOF
  read -r -p "    press Enter when you have taken those screenshots: " _; scripts/m2/shot.sh 1.7 complete
  cat <<EOF

>>> Next the script makes shard 1 unreachable for 4 minutes (data stays on disk).
    While it runs: reload the dashboard, click Muat, SCREENSHOT the incomplete banner (it names the unavailable unit). Take another one after it recovers (the script says when).
EOF
  need_healthy || return 1
  read -r -p "    press Enter to start: " _
  DOWN_SECONDS=240 ARTIFICIAL="a whole shard is made unreachable for 4 minutes, its data stays on disk" rp 1.7-partial scripts/m2/p1-unit-loss.sh 1
  scripts/m2/shot.sh 1.7 incomplete-banner
  echo; echo ">>> now reload the dashboard once more and click Muat: the banner should be green again"; read -r -p "    screenshot it, then press Enter: " _; scripts/m2/shot.sh 1.7 recovered
}
item_1_7b() {
  cat <<EOT

>>> 1.7b: the two missing browser proofs (the "Cocokkan" result and the incomplete banner)
    A. Open  http://$NODE_IP:30000/analytics , paste the token, keep "24 jam", click Muat (green banner).
       Click "Cocokkan dengan Audit API" and WAIT (about 15 s) until the line "Menghitung ulang lewat Audit API..." is replaced by a result line. SCREENSHOT that result.
EOT
  read -r -p "    press Enter when you have that screenshot: " _; scripts/m2/shot.sh 1.7 match
  cat <<EOT

>>> B. Keep the dashboard open in the browser. When the terminal prints ">>> stopping both data members of shard-1", switch to the browser, click Muat, WAIT for the
    page to finish loading (it can take up to 10 s), and SCREENSHOT the banner (it should name shard-1). You have 5 minutes; take two shots to be safe.
EOT
  need_healthy || return 1
  read -r -p "    press Enter to start the outage: " _
  DOWN_SECONDS=300 ARTIFICIAL="a whole shard is made unreachable for 5 minutes, its data stays on disk" rp 1.7-partial scripts/m2/p1-unit-loss.sh 1
  scripts/m2/shot.sh 1.7 incomplete-banner
}
item_2_1() { rp 2.1 bash "$SELF" _pods; shots 2.1; }
item_2_2() { rp 2.2 scripts/m2/p2-single-fetch.sh; shots 2.2; }
item_2_3() { need_healthy || return 1; rp 2.3 scripts/m2/p2-failover.sh; shots 2.3 shot "the failover time and the PASS lines"; }
item_2_4() { need_healthy || return 1; rp 2.4 scripts/m2/p2-clock-skew.sh; shots 2.4; }
item_2_5() { need_healthy || return 1; rp 2.5 scripts/m2/p2-freeze.sh; shots 2.5; }
item_2_6() { need_healthy || return 1; THINK_S=140 DURATION_S=340 ARTIFICIAL="a light asynchronous generator holds 10,000 users (k6 cannot here), about 71 req/s in total; 2.8 (rolling update under load) is in the same run" rp 2.6 scripts/m2/p2-load-10k.sh; shots 2.6 shot "the scaling lines (t=...), the error rate and the PASS lines"; }
item_2_7() { need_healthy || return 1; ARTIFICIAL="every aggregator pod is limited to 250m CPU for this test; without the cap the host CPU is the bottleneck and the ratio is about 0.9x" rp 2.7 scripts/m2/p2-throughput-capped.sh; shots 2.7; }
item_3_1() { need_healthy || return 1; rp 3.1 scripts/m2/p3-checks.sh; shots 3.1 shot "the PASS lines (there are 33; take two screenshots if they do not fit)"; }
item_3_4() { need_healthy || return 1; ARTIFICIAL="several versions of one report are put in the parked inbox directly (the mock cannot serve several versions)" rp 3.4 scripts/m2/p3-order.sh; shots 3.4; }
item_3_6() {
  need_healthy || return 1
  local cmd="'$VB' controlvm node-d poweroff; sleep 80; '$VB' startvm node-d --type headless"
  rp 3.6 scripts/m2/p1-write-probe.sh 150 "$cmd"; shots 3.6 shot "the write counts (all 202) and the PASS lines"
}
item_4_1() { ARTIFICIAL="our own independent recomputation from the feed log (the assistants' reference is released after the deadline)" rp 4.1 bash "$SELF" _reference; shots 4.1 shot "the comparison (missing 0, extra 0, different 0)"; }
item_4_2() { ARTIFICIAL="unit tests with injected late detections (the live feed produced none)" rp 4.2 bash "$SELF" _late; shots 4.2; }
item_4_4() {
  need_healthy || return 1
  SCENARIO=baseline rp 4.4-baseline scripts/m2/p4-checks.sh; shots 4.4-baseline shot "the p95 line (ingest-to-store)"
  ARTIFICIAL="the surge is a backlog built while the feed connection is cut for 90 s, not a faster feed (the feed already runs at 60x)" CUT_S=90 rp 4.4-backlog scripts/m2/p4-reconnect.sh; shots 4.4-backlog
  ui_forwards; echo ">>> Grafana: open the satellite dashboard and SCREENSHOT the lag / backlog panel (set the time range to the last 15 minutes so the cut shows)"; read -r -p "    Enter when done: " _; scripts/m2/shot.sh 4.4 grafana-lag; ui_stop
}
item_4_5() { need_healthy || return 1; SCENARIO=kill-leader rp 4.5 scripts/m2/p4-checks.sh; shots 4.5; }
item_4_7() { rp 4.7 bash "$SELF" _live; shots 4.7 shot "the three metric snapshots (offset moving, lag small)"; ui_forwards; echo ">>> Grafana: SCREENSHOT the satellite dashboard (active fires, offset, lag) with the time range set to the last 15 minutes"; read -r -p "    Enter when done: " _; scripts/m2/shot.sh 4.7 grafana; ui_stop; }
item_4_8() { need_healthy || return 1; ARTIFICIAL="the connection is cut with a firewall rule on the leader's node" CUT_S=20 rp 4.8 scripts/m2/p4-reconnect.sh; shots 4.8; }
item_5_1() {
  need_healthy || return 1
  SCENARIO=baseline N=300 RATE=5 rp 5.1-baseline scripts/m2/p5-latency.sh; shots 5.1-baseline
  need_healthy || return 1
  ARTIFICIAL="the coastal leader process is killed (SIGKILL), the node stays up" SCENARIO=kill-leader N=400 RATE=5 FAIL_AT_S=40 rp 5.1-crash scripts/m2/p5-latency.sh; shots 5.1-crash
}
item_5_2() { rp 5.2 scripts/m2/p5-quarantine.sh; shots 5.2; }
item_5_3() { need_healthy || return 1; ARTIFICIAL="the M1 workload is scaled down to 4 users (2 SEISMIC + 2 VOLCANIC; the VMs serve about 45-50 req/s of /events with no think time, so latency is about users / 45 s; at 6 users the p95 was 235-321 ms, at the edge of 300 ms, with a healthy sensor too)" VUS_EACH=2 MODES="normal slow blackhole" rp 5.3 scripts/m2/p5-m1-load.sh; shots 5.3; }
item_5_4() { need_healthy || return 1; rp 5.4 scripts/m2/p5-checks.sh; shots 5.4 shot "the PASS lines for the six sensor modes (take two screenshots if they do not fit)"; }
item_5_5() {
  need_healthy || return 1
  # The VMs serve only about 50 req/s. With the default Media ceiling (30 in flight per client-api pod) 40 Media users are never rejected and the shared queue still gives
  # Tim Lapangan a p95 of 1.3 s; at 100 users the rejections themselves cost CPU. A lower ceiling shows the mechanism (Media rejected with 429, Tim Lapangan served) at this size.
  local old; old=$(kubectl -n "$NS" get deploy client-api -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MEDIA_MAX_IN_FLIGHT")].value}')
  echo ">>> ARTIFICIAL: the Media ceiling is lowered to ${MEDIA_CEILING:-6} per client-api pod for this proof (it is ${old:-30} normally and is restored afterwards)"
  kubectl -n "$NS" set env deploy/client-api MEDIA_MAX_IN_FLIGHT="${MEDIA_CEILING:-6}" >/dev/null; kubectl -n "$NS" rollout status deploy/client-api --timeout=300s >/dev/null; sleep 25
  ARTIFICIAL="the Media ceiling is lowered to ${MEDIA_CEILING:-6} in flight per client-api pod (normally ${old:-30}), with 40 Media and 5 Tim Lapangan users, because the VMs serve only about 50 req/s" rp 5.5 bash "$SELF" _priority; local rc=$?
  if [ -n "$old" ]; then kubectl -n "$NS" set env deploy/client-api MEDIA_MAX_IN_FLIGHT="$old" >/dev/null; else kubectl -n "$NS" set env deploy/client-api MEDIA_MAX_IN_FLIGHT- >/dev/null; fi
  kubectl -n "$NS" rollout status deploy/client-api --timeout=300s >/dev/null; echo ">>> Media ceiling restored (${old:-default 30})"
  shots 5.5; return $rc
}
item_5_7() {
  rp 5.7-fieldreport bash "$SELF" _trace; shots 5.7-fieldreport
  SCENARIO=baseline N=30 RATE=5 rp 5.7-coastal-run scripts/m2/p5-latency.sh
  rp 5.7-coastal-trace bash "$SELF" _trace_coastal; shots 5.7-coastal-trace
  ui_forwards; echo ">>> Jaeger: service 'client-api', find the trace of the field report above (correlation id proof-...), open it and SCREENSHOT the waterfall. Then service 'aggregator', operation 'coastal critical ingest', open one trace and SCREENSHOT it."
  read -r -p "    Enter when done: " _; scripts/m2/shot.sh 5.7 jaeger
  echo ">>> Grafana: SCREENSHOT 'BNPB coordination, broker and store' (leader/epoch, store, RabbitMQ) and the coastal dashboard"; read -r -p "    Enter when done: " _; scripts/m2/shot.sh 5.7 grafana; ui_stop
}
item_H_1() {
  need_healthy || return 1
  ARTIFICIAL="a ramped closed-loop load (k6) rises to 60 users and falls again; replicas are sampled every 10 s" rp H.1 scripts/m2/hpa-ramp.sh; shots H.1 shot "the replica table: the ramp-up, the peak and the scale-down back to the minimum (two shots if it does not fit)"
  ui_forwards; echo ">>> Grafana: open 'BNPB overview', panel 'Memory working set per pod' (one line per pod, so lines appear as pods are added and disappear as they are removed), time range Last 30 minutes, and SCREENSHOT it; also the 'Throughput (req/s) per service' panel for the same window"
  read -r -p "    Enter when done: " _; scripts/m2/shot.sh H.1 grafana; ui_stop
}
item_G_1() { rp G.1 bash -c 'scripts/m2/verify-resources.sh; scripts/m2/verify-isolation.sh; scripts/m2/smoke.sh'; shots G.1 shot "the final lines of each of the three checks"; }
item_G_2() { rp G.2-log bash "$SELF" _logline; shots G.2-log; ui_forwards; echo ">>> Grafana: SCREENSHOT 'BNPB overview' (latency, throughput, error rate per service) with the last 15 minutes"; read -r -p "    Enter when done: " _; scripts/m2/shot.sh G.2 grafana-overview; ui_stop; }
item_G_3() { rp G.3 scripts/m2/audit-contract.sh; shots G.3 shot "the PASS lines (take two screenshots if they do not fit)"; }

ORDER_P1="1.1 1.2 1.3 1.4 1.5 1.6 1.7"; ORDER_P2="2.1 2.2 2.3 2.4 2.5 2.6 2.7"; ORDER_P3="3.1 3.4 3.6"; ORDER_P4="4.1 4.2 4.4 4.5 4.7 4.8"; ORDER_P5="5.1 5.2 5.3 5.4 5.5 5.7"; ORDER_G="G.1 G.2 G.3 H.1"
list() { cat <<'EOF'
P1  1.1 data spread per node            1.2 regional burst (writes 20,000 simulated events)   1.3 global query and order
    1.4 node loss, erased volumes + a whole shard down (BREAKS: several minutes)   1.5 writes during the re-sync (BREAKS)   1.6 second loss (BREAKS)
    1.7 analytics dashboard in the browser (a shard goes down for 4 minutes)   1.7b only the missing 'Cocokkan' result and incomplete-banner shots (5-minute outage)
P2  2.1 instances on different nodes    2.2 single fetch    2.3 failover (real power-off of a node)   2.4 clock skew   2.5 freeze   2.6 10,000 users + scaling + rolling update (also 2.8)
    2.7 throughput 1 vs 3 instances under a CPU cap (changes the aggregator for the test)
P3  3.1 schema, parking, corrupt data, Ops-only, durable 202 (33 checks; stops RabbitMQ briefly)   3.4 per-key replay order   3.6 writes through a real node power-off
P4  4.1 reference comparison (minutes)  4.2 late-detection unit tests  4.4 60x: p95 and backlog catch-up (+ Grafana)  4.5 leader killed  4.7 live stream (+ Grafana)  4.8 connection reset
P5  5.1 critical alert latency: baseline and leader crash   5.2 quarantine   5.3 M1 workload with a sick sensor   5.4 sensor fault modes   5.5 priority under a flood   5.7 traces (+ Jaeger, Grafana)
G   G.1 platform checks   G.2 logs and the overview dashboard   G.3 Audit API contract   H.1 HPA bonus: replicas follow a load ramp up and down (about 12 min)
Groups: p1 p2 p3 p4 p5 g     One item: scripts/m2/proof.sh 1.2
EOF
}
run_item() { local id=$1 fn="item_${1//./_}"; fn=${fn//-/_}; declare -F "$fn" >/dev/null || { echo "unknown item $1 (try: list)"; return 2; }; echo; echo "=================== item $id ==================="; "$fn"; }
case "${1:-list}" in
  list|-h|--help) list ;;
  _*) internal "$@"; exit $? ;;
  p1) group=$ORDER_P1 ;; p2) group=$ORDER_P2 ;; p3) group=$ORDER_P3 ;; p4) group=$ORDER_P4 ;; p5) group=$ORDER_P5 ;; g|G) group=$ORDER_G ;;
  *) run_item "$1"; exit $? ;;
esac
if [ -n "${group:-}" ]; then
  for id in $group; do read -r -p "next: item $id. Enter = run, s = skip, q = quit: " a; [ "$a" = q ] && break; [ "$a" = s ] && continue; run_item "$id"; done
fi
