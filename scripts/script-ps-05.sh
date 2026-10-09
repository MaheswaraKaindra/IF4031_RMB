# bash scripts/verify-pubsub.sh
# PAUSE=1 bash scripts/verify-pubsub.sh

cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

MGMT="localhost:${RABBITMQ_MANAGEMENT_PORT:-15672}/api"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

shot() {
    echo ">>> SCREENSHOT $1"
    if [ "${PAUSE:-0}" = "1" ]; then printf 'press Enter to continue: '; read -r _; fi
}

rmq() { docker compose exec -T rabbitmq rabbitmqctl -q "$@"; }
queues() { rmq list_queues name durable messages_ready messages_unacknowledged messages_persistent consumers | grep -E '^(name|q_)'; }
bindings() { rmq list_bindings source_name destination_name | grep -E '^(source_name|hazard_events)'; }
consumers() { rmq list_consumers queue_name channel_pid ack_required prefetch_count; }
broker_ready() { until docker compose exec -T rabbitmq rabbitmq-diagnostics -q check_running >/dev/null 2>&1; do sleep 2; done; }
mg() { curl -s -u "$RABBITMQ_USERNAME:$RABBITMQ_PASSWORD" -H 'content-type: application/json' "$@"; }
count() { wc -l | tr -d ' '; }
aggregator_health() { docker compose exec -T aggregator wget -qO- http://127.0.0.1:3000/health; echo; }

events() {
    docker compose logs --no-log-prefix --since "$3" --until "${4:-$(now)}" "$1" 2>&1 \
        | jq -Rr --arg m "$2" 'fromjson? | select(.msg|test($m)) | "\(.hazard_id):\(.severity) \(.time[11:23])"' \
        | grep -v '^DEMO' | sort -u -k1,1
}
keys() { events "$@" | cut -d' ' -f1; }

snap() {
    docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} cid={{printf "%.12s" .Id}} img={{printf "%.19s" .Image}} started={{.State.StartedAt}} restarts={{.RestartCount}}' \
        "$(docker compose ps -q aggregator)"
}
src_sum() { find aggregator/src -type f | sort | xargs shasum | shasum | cut -c1-16; }

trace() {
    local id="$1"; shift
    for s in aggregator "$@"; do
        docker compose logs --no-log-prefix "$s" 2>&1 | grep "$id" \
            | jq -Rr 'fromjson? | "\(.time) \(.service) correlation_id=\(.correlation_id) hazard_id=\(.hazard_id) severity=\(.severity) \(.msg)"'
    done
}
last_published() {
    docker compose logs --no-log-prefix --since 60s aggregator 2>&1 \
        | jq -Rr 'fromjson? | select(.msg=="Published HazardEvent") | .hazard_id' | tail -n 1
}

inject() {
    mg -X POST "$MGMT/exchanges/%2F/hazard_events/publish" -d "$(jq -nc --arg id "$1" --arg sev "$2" '{
        properties: {message_id: ($id + ":" + $sev), delivery_mode: 2, content_type: "application/json", correlation_id: "idempotency-test"},
        routing_key: "", payload_encoding: "string",
        payload: ({hazard_id: $id, severity: $sev, area_name: "DEMO"} | tojson)}')"
    echo
}
processed_copies() {
    for s in consumer-notifier consumer-dashboard consumer-portal; do
        echo "$s processed: $(docker compose logs --no-log-prefix "$s" 2>&1 | grep -c "$1")"
    done
}

echo "== Step 0: reset state (remove consumer-portal and its queue)"
docker compose --profile demo rm -sf consumer-portal
mg -X DELETE "$MGMT/queues/%2F/q_regional_portal" -o /dev/null -w "delete q_regional_portal: HTTP %{http_code}\n"
docker compose up -d consumer-notifier consumer-dashboard
sleep 5
queues


echo
echo "== Step 1: HazardEvent is published to the broker, not sent to consumers (criterion 1)"
echo "-- exchange"
rmq list_exchanges name type durable | grep -E '^(name|hazard_events)'
echo "-- bindings (exchange -> queue)"
bindings
echo "-- queues"
queues
shot S-01

echo "-- references to consumers or queues inside aggregator/src (expected: 0)"
grep -rniE 'q_|notifier|dashboard|portal|consumer' aggregator/src | grep -v RABBITMQ_URL | count
echo "-- aggregator dependencies in docker-compose.yml (broker and store only, no consumer)"
awk '/^  aggregator:/{f=1} /^  client-api:/{f=0} f' docker-compose.yml | sed -n '/depends_on:/,/healthcheck:/p'
shot S-02

echo "-- recent events published by the aggregator"
docker compose logs --no-log-prefix --since 30s aggregator 2>&1 \
    | jq -Rr 'fromjson? | select(.msg=="Published HazardEvent") | "\(.time) \(.service) hazard_id=\(.hazard_id) source=\(.source) severity=\(.severity) \(.msg)"' | tail -n 5
echo "-- one message as stored in the broker (temporary queue q_inspect, waits 15s)"
mg -X PUT "$MGMT/queues/%2F/q_inspect" -d '{"durable":true}' -o /dev/null
mg -X POST "$MGMT/bindings/%2F/e/hazard_events/q/q_inspect" -d '{"routing_key":""}' -o /dev/null
sleep 15
mg -X POST "$MGMT/queues/%2F/q_inspect/get" -d '{"count":1,"ackmode":"ack_requeue_false","encoding":"auto"}' \
    | jq -c '.[0] | {delivery_mode: .properties.delivery_mode, message_id: .properties.message_id, correlation_id: .properties.correlation_id, content_type: .properties.content_type, payload: (.payload|fromjson)}'
mg -X DELETE "$MGMT/queues/%2F/q_inspect" -o /dev/null
shot S-03


echo
echo "== Step 2: two independent consumers on the same stream (criterion 2)"
echo "-- consumer containers"
docker compose ps --format '{{.Service}} {{.Status}}' | grep -E '^(aggregator|consumer-)'
echo "-- consumers attached to the broker (one channel per queue)"
consumers
shot S-04

sleep 2
H=$(last_published)
echo "-- one hazard event seen by the producer and by both consumers: $H"
trace "$H" consumer-dashboard consumer-notifier
shot S-05


echo
echo "== Step 3: stop consumer-notifier, then start it again (criterion 3)"
echo "-- baseline"
queues
shot S-06

docker compose stop consumer-notifier
T_STOP=$(now)
echo "T_STOP=$T_STOP"
sleep 45
T_END=$(now)
echo "-- queues while consumer-notifier is down"
queues
shot S-07

sleep 2
events aggregator 'Published HazardEvent' "$T_STOP" "$T_END" > /tmp/p5_published.txt
keys aggregator 'Published HazardEvent' "$T_STOP" "$T_END" > /tmp/p5_published_keys.txt
keys consumer-dashboard 'Received update' "$T_STOP" > /tmp/p5_dashboard_keys.txt
echo "-- publish times during the outage (producer was not blocked)"
cut -d' ' -f2 /tmp/p5_published.txt | sort | tr '\n' ' '; echo
echo "published by aggregator during outage : $(count < /tmp/p5_published_keys.txt)"
echo "received by consumer-dashboard        : $(count < /tmp/p5_dashboard_keys.txt)"
echo "processed by consumer-notifier        : $(keys consumer-notifier 'Event ignored|SENDING EMERGENCY ALERT' "$T_STOP" | count)"
echo "published but not received by consumer-dashboard (expected: none):"
comm -23 /tmp/p5_published_keys.txt /tmp/p5_dashboard_keys.txt
echo "-- aggregator after the outage window"
aggregator_health
snap
shot S-08

T_START=$(now)
echo "T_START=$T_START"
docker compose start consumer-notifier
sleep 15
echo "-- queues after consumer-notifier is back"
queues
shot S-09

keys consumer-notifier 'Event ignored|SENDING EMERGENCY ALERT' "$T_START" > /tmp/p5_notifier_after.txt
keys aggregator 'Published HazardEvent' "$T_STOP" "$T_START" > /tmp/p5_gap.txt
echo "published while consumer-notifier was down     : $(count < /tmp/p5_gap.txt)"
echo "processed by consumer-notifier after restart   : $(count < /tmp/p5_notifier_after.txt) (includes events published after restart)"
echo "published during the outage but never processed (expected: none):"
comm -23 /tmp/p5_gap.txt /tmp/p5_notifier_after.txt
echo "-- per event: time published by aggregator, time processed by consumer-notifier"
join <(events aggregator 'Published HazardEvent' "$T_STOP" "$T_START") \
     <(events consumer-notifier 'Event ignored|SENDING EMERGENCY ALERT' "$T_START") \
    | sort -k2 | awk '{print $1, "published=" $2, "processed=" $3}'
shot S-10

echo "-- queue settings that explain the catch-up"
rmq list_queues name durable auto_delete exclusive arguments | grep -E '^(name|q_)'
echo "policies:"
rmq list_policies
echo "consumers (ack_required=true means manual ack):"
consumers
shot S-11


echo
echo "== Step 3b: backlog survives a broker restart (criterion 3, durability)"
docker compose stop consumer-notifier
sleep 25
echo "-- queues before broker restart"
queues
docker compose restart rabbitmq
broker_ready
echo "-- queues after broker restart (messages_ready must not be lower than before)"
queues
docker compose start consumer-notifier
sleep 20
echo "-- queues after consumer-notifier is back"
queues
shot S-12


echo
echo "== Step 4: add a third consumer without touching the producer (criterion 4)"
echo "-- before"
queues
bindings
SNAP_BEFORE=$(snap)
SUM_BEFORE=$(src_sum)
echo "$SNAP_BEFORE"
echo "aggregator source checksum: $SUM_BEFORE"
shot S-13

docker compose --profile demo up -d --build consumer-portal
sleep 25
echo "-- after"
queues
bindings
SNAP_AFTER=$(snap)
SUM_AFTER=$(src_sum)
echo "$SNAP_AFTER"
echo "aggregator source checksum: $SUM_AFTER"
if [ "$SNAP_BEFORE" = "$SNAP_AFTER" ] && [ "$SUM_BEFORE" = "$SUM_AFTER" ]; then
    echo "aggregator unchanged (same container, same start time, same source): yes"
else
    echo "aggregator unchanged (same container, same start time, same source): NO"
fi
shot S-14

H=$(last_published)
echo "-- one hazard event seen by the producer and all three consumers: $H"
trace "$H" consumer-dashboard consumer-notifier consumer-portal
shot S-15

echo "-- optional: a fourth consumer with no code (queue and binding created through the management API)"
mg -X PUT "$MGMT/queues/%2F/q_extra_consumer" -d '{"durable":true}' -o /dev/null
mg -X POST "$MGMT/bindings/%2F/e/hazard_events/q/q_extra_consumer" -d '{"routing_key":""}' -o /dev/null
bindings
sleep 12
mg -X POST "$MGMT/queues/%2F/q_extra_consumer/get" -d '{"count":2,"ackmode":"ack_requeue_false","encoding":"auto"}' \
    | jq -c '.[] | {hazard_id: (.payload|fromjson|.hazard_id), severity: (.payload|fromjson|.severity)}'
mg -X DELETE "$MGMT/queues/%2F/q_extra_consumer" -o /dev/null
shot S-16


echo
echo "== Step 5: duplicate delivery and consumer idempotency (criterion 5)"
ID="DEMO-IDEM-$(date +%s)"
echo "-- publishing the same message (message_id=$ID:AWAS) twice"
inject "$ID" AWAS
inject "$ID" AWAS
sleep 3
processed_copies "$ID"
shot S-17

echo "-- restarting consumer-notifier (its in-memory deduplication set is lost), then publishing the same message again"
docker compose restart consumer-notifier
sleep 12
inject "$ID" AWAS
sleep 3
processed_copies "$ID"
shot S-18


echo
echo "== Step 6: broker outage does not stop the producer"
T_OUT=$(now)
docker compose stop rabbitmq
sleep 30
echo "-- aggregator health while the broker is down"
aggregator_health
docker compose logs --no-log-prefix --since "$T_OUT" aggregator 2>&1 \
    | jq -Rr 'fromjson? | select(.msg|test("buffered|connection lost")) | "\(.time) \(.level) pending=\(.pending // "-") \(.msg)"' | tail -n 4
shot S-19

docker compose start rabbitmq
broker_ready
sleep 30
echo "-- aggregator after the broker is back"
docker compose logs --no-log-prefix --since "$T_OUT" aggregator 2>&1 \
    | jq -Rr 'fromjson? | select(.msg|test("Connected to RabbitMQ|Publishing buffered")) | "\(.time) \(.msg) count=\(.count // "-")"'
queues
snap
shot S-20

echo
echo "Done."
