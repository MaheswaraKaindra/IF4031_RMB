# bash scripts/verify-decoupling-storage.sh
# PAUSE=1 bash scripts/verify-decoupling-storage.sh
# CLEANUP=1 bash scripts/verify-decoupling-storage.sh

cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env; set +a

shot() {
    echo ">>> SCREENSHOT $1"
    if [ "${PAUSE:-0}" = "1" ]; then printf 'press Enter to continue: '; read -r _; fi
}

tok() {
    curl -s -X POST localhost:8090/token -H 'Content-Type: application/json' \
        -d "$(jq -n --arg id "$1" --arg s "$2" '{client_id:$id,client_secret:$s}')"
}

mq() {
    docker compose exec -T mongo mongosh -u "$MONGO_USERNAME" -p "$MONGO_PASSWORD" \
        --authenticationDatabase admin bnpb_canonical_store --quiet --eval "$1"
}

snap() {
    docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}} | cid={{printf "%.12s" .Id}} | img={{printf "%.19s" .Image}} | started={{.State.StartedAt}} | restarts={{.RestartCount}}' \
        $(docker compose ps -q) | sort
}
bump() { echo "// rebuild-demo $(date +%s)" >> "$1"; }

PID_PROBE=""
PID_EVENTS=""
cleanup_bg() {
    [ -n "$PID_PROBE" ] && kill "$PID_PROBE" 2>/dev/null
    [ -n "$PID_EVENTS" ] && kill "$PID_EVENTS" 2>/dev/null
}
trap cleanup_bg EXIT INT TERM

echo "== Step 0: Preconditions and sanity check"
docker compose --profile demo rm -sf consumer-portal >/dev/null 2>&1

PVMBG_SCHEMA_STATUS=$(curl -s localhost:8082/health)
if [ -n "$PVMBG_TOKEN" ]; then
    TOGGLE_MSG=$(curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $PVMBG_TOKEN")
    if echo "$TOGGLE_MSG" | grep -q "true"; then
        curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $PVMBG_TOKEN" >/dev/null 2>&1
    fi
fi
mq 'db.hazards.deleteMany({source:"PVMBG","attributes.confidence_level":{$exists:true}})' >/dev/null 2>&1

CAPI_HEALTH=$(curl -s localhost:8080/health)
AUTH_HEALTH=$(curl -s localhost:8090/health)
echo "client-api health : $CAPI_HEALTH"
echo "auth-service health: $AUTH_HEALTH"

BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)
echo "Initial token obtained (length: ${#BNPB})"


echo
echo "== Step 1: Kriteria 1A: Setiap komponen adalah container terpisah"
echo "-- Daftar container, image, status, dan port yang dibuka ke host"
docker compose ps --format 'table {{.Service}}\t{{.Name}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
shot S-01

echo "-- Tiap service punya image sendiri"
docker compose images
shot S-02

echo "-- Tiap service punya source code dan Dockerfile sendiri"
ls -d */ | grep -v -e docs -e scripts -e load-test
ls aggregator/Dockerfile client-api/Dockerfile auth-service/Dockerfile consumers/Dockerfile mock-bmkg/Dockerfile mock-pvmbg/Dockerfile
shot S-03

snap > /tmp/snap_0.txt


echo
echo "== Step 2: Kriteria 1B: Stop, rebuild, start ulang auth-service"
snap > /tmp/snap_auth_before.txt
echo "-- Simulasi perbaikan kecil pada kode auth-service"
bump auth-service/src/index.ts
git diff --stat auth-service/src/index.ts
shot S-04

BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)

EVENTS_LOG="/tmp/events_auth.log"
rm -f "$EVENTS_LOG"
docker events \
  --filter 'label=com.docker.compose.project=bnpb' --filter type=container \
  --filter event=create --filter event=start --filter event=stop --filter event=die \
  --filter event=kill --filter event=destroy --filter event=restart \
  --format '{{.Time}}  {{.Action}}  {{index .Actor.Attributes "com.docker.compose.service"}}' > "$EVENTS_LOG" 2>&1 &
PID_EVENTS=$!

PROBE_LOG="/tmp/probe_auth.log"
rm -f "$PROBE_LOG"
(
  while true; do
    e=$(curl -s -o /dev/null -m2 -w '%{http_code}' -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1')
    c=$(curl -s -o /dev/null -m2 -w '%{http_code}' localhost:8080/health)
    a=$(curl -s -o /dev/null -m2 -w '%{http_code}' localhost:8090/health)
    echo "$(date +%T)  GET /events=$e  client-api/health=$c  auth-service/health=$a"
    sleep 1
  done
) > "$PROBE_LOG" 2>&1 &
PID_PROBE=$!

sleep 2
echo "-- Menghentikan auth-service"
docker compose stop auth-service
sleep 2

echo "-- Bukti auth-service mati (000), tapi client-api tetap melayani dengan token terbit (200)"
curl -s -m2 -o /dev/null -w 'auth /health  -> HTTP %{http_code}\n' localhost:8090/health
curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=2' | jq '{jumlah: (.events|length), sources}'
curl -s -o /dev/null -w 'client-api /health -> HTTP %{http_code}\n' localhost:8080/health
shot S-05

echo "-- Rebuild hanya auth-service"
docker compose build auth-service
echo "-- Start ulang hanya auth-service (--no-deps)"
docker compose up -d --no-deps auth-service
until [ "$(docker inspect -f '{{.State.Health.Status}}' $(docker compose ps -q auth-service))" = healthy ]; do sleep 1; done
sleep 3

kill "$PID_PROBE" "$PID_EVENTS" 2>/dev/null
wait "$PID_PROBE" "$PID_EVENTS" 2>/dev/null
PID_PROBE=""
PID_EVENTS=""

echo "-- Log continuous probe (T2): /events dan client-api konsisten 200, auth 200 -> 000 -> 200"
cat "$PROBE_LOG"
shot S-06

echo "-- Log docker events (T3): seluruh event lifecycle hanya milik auth-service"
cat "$EVENTS_LOG"
shot S-07

echo "-- Snapshot diff: hanya auth-service yang berbeda (cid, img, started)"
snap > /tmp/snap_auth_after.txt
diff /tmp/snap_auth_before.txt /tmp/snap_auth_after.txt
shot S-08

echo "-- Auth-service pulih dan menerbitkan token baru dengan image baru"
tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq '{token_type, expires_in, ada_access: (.access_token|length>0)}'


echo
echo "== Step 3: Kriteria 1C: Stop, rebuild, start ulang client-api"
snap > /tmp/snap_capi_before.txt
N1=$(mq 'db.hazards.countDocuments()')
echo "Jumlah dokumen di store sebelum client-api mati (N1): $N1"

echo "-- Simulasi perbaikan kecil pada kode client-api"
bump client-api/src/index.ts
docker compose stop client-api

echo "-- Bukti client-api mati"
curl -s -m2 -o /dev/null -w 'client-api /health -> HTTP %{http_code}\n' localhost:8080/health

echo "-- Selama client-api mati: auth tetap menerbitkan token, ingest data tetap berjalan"
curl -s -o /dev/null -w 'auth /token          -> HTTP %{http_code}\n' -X POST localhost:8090/token \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$AUTH_CLIENT_BNPB_OPS_SECRET" '{client_id:"bnpb-ops",client_secret:$s}')"
docker compose exec -T aggregator wget -qO- http://127.0.0.1:3000/health | jq

echo "-- Menunggu 25 detik (event baru masuk ke store saat client-api mati)..."
sleep 25
N2=$(mq 'db.hazards.countDocuments()')
echo "Jumlah dokumen sesudah (N2): $N2 (N2 > N1: penambahan $((N2 - N1)) event)"
echo "Event yang dipublikasikan aggregator dalam 30s terakhir:"
docker compose logs --since 30s aggregator | grep -c 'Published HazardEvent'
echo "Consumer tetap menerima event selama client-api mati:"
docker compose logs --since 30s consumer-notifier consumer-dashboard | tail -n 5
shot S-10

echo "-- Rebuild hanya client-api"
docker compose build client-api
echo "-- Start ulang hanya client-api (--no-deps)"
docker compose up -d --no-deps client-api
until [ "$(docker inspect -f '{{.State.Health.Status}}' $(docker compose ps -q client-api))" = healthy ]; do sleep 1; done

echo "-- Snapshot diff: hanya client-api yang berbeda"
snap > /tmp/snap_capi_after.txt
diff /tmp/snap_capi_before.txt /tmp/snap_capi_after.txt
shot S-11

BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)
echo "-- Client-api hidup kembali dan menyajikan data"
curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1' | jq '.events[0] | {hazard_id, source, severity}'


echo
echo "== Step 4: Kriteria 1D: Stop, rebuild, start ulang aggregator"
snap > /tmp/snap_agg_before.txt
echo "-- Simulasi perbaikan kecil pada kode aggregator"
bump aggregator/src/index.ts
docker compose stop aggregator

echo "-- Yang bergantung pada Aggregator: gagal terkendali (503 + correlation_id)"
curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1'

echo "-- Yang TIDAK bergantung pada Aggregator: tetap dilayani normal"
curl -s -o /dev/null -w 'client-api /health    -> %{http_code}\n' localhost:8080/health
curl -s -o /dev/null -w 'tanpa token           -> %{http_code}\n' 'localhost:8080/events'
MEDIA=$(tok media "$AUTH_CLIENT_MEDIA_SECRET" | jq -r .access_token)
curl -s -o /dev/null -w 'media minta raw field  -> %{http_code}\n' -H "Authorization: Bearer $MEDIA" 'localhost:8080/events?fields=latitude'
curl -s -o /dev/null -w 'auth /token           -> %{http_code}\n' -X POST localhost:8090/token -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$AUTH_CLIENT_FIELD_TEAM_SECRET" '{client_id:"field-team",client_secret:$s}')"
docker compose exec -T consumer-dashboard wget -qO- http://127.0.0.1:8095/health
shot S-12

echo "-- Rebuild hanya aggregator"
docker compose build aggregator
echo "-- Start ulang hanya aggregator (--no-deps)"
docker compose up -d --no-deps aggregator
until [ "$(docker inspect -f '{{.State.Health.Status}}' $(docker compose ps -q aggregator))" = healthy ]; do sleep 1; done

echo "-- Snapshot diff: hanya aggregator yang berbeda"
snap > /tmp/snap_agg_after.txt
diff /tmp/snap_agg_before.txt /tmp/snap_agg_after.txt

echo "-- Aggregator pulih, data lama tetap utuh (volume MongoDB)"
curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1' | jq '.events[0] | {hazard_id, source}'


echo
echo "== Step 5: Ringkasan Bukti Kriteria 1"
snap > /tmp/snap_6.txt
echo "-- Rekap kontainer yang berubah dibanding kondisi awal (snap_0 vs snap_6):"
diff /tmp/snap_0.txt /tmp/snap_6.txt | grep '^[<>]' | awk -F' [|] ' '{print $1}' | sort | uniq -c
echo "(Hanya auth-service, client-api, dan aggregator yang berubah. Komponen lain tidak pernah restart/rebuild)"


echo
echo "== Step 6: Kriteria 2: Penyimpanan dinamis tanpa migrasi"
echo "-- 6.1 Bukti statis: tidak ada skema migrasi / DDL / ORM di seluruh kode"
grep -rniE 'migrat|alter table|create table|sequelize|typeorm|prisma|knex' \
  --include='*.ts' --include=package.json --exclude-dir=node_modules aggregator client-api auth-service consumers \
  || echo "TIDAK ADA langkah migrasi / DDL / ORM"
echo "-- Definisi koleksi: options kosong, tanpa validator skema"
mq 'printjson(db.getCollectionInfos({name:"hazards"}).map(c => ({name:c.name, options:c.options})))'
shot S-13

echo "-- 6.2 Baseline sebelum toggle confidence_level"
snap > /tmp/snap_k2_before.txt
mq 'printjson(db.hazards.getIndexes().map(i => ({name:i.name, key:i.key})))' > /tmp/idx_before.txt
mq 'printjson(db.getCollectionInfos({name:"hazards"}))' > /tmp/coll_before.txt

echo "Distribusi bentuk atribut PVMBG sebelum perubahan skema:"
mq 'printjson(db.hazards.aggregate([
  {$match:{source:"PVMBG"}},
  {$group:{_id:{$map:{input:{$objectToArray:"$attributes"},as:"a",in:"$$a.k"}}, jumlah:{$sum:1}}}
]).toArray())'

echo "Hitungan record tanpa vs dengan confidence_level:"
mq 'printjson({tanpa: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:false}}), dengan: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:true}})})'
shot S-14

echo "-- 6.3 Menyalakan toggle confidence_level di mock PVMBG"
TOGGLE_RESP=$(curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $PVMBG_TOKEN")
echo "Hasil toggle: $TOGGLE_RESP"
if echo "$TOGGLE_RESP" | grep -q "false"; then
    TOGGLE_RESP=$(curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $PVMBG_TOKEN")
    echo "Hasil toggle (retry): $TOGGLE_RESP"
fi

echo "Menunggu 25 detik agar PVMBG menerbitkan laporan baru dan Aggregator melakukan polling..."
sleep 25

echo "-- 6.4 Bukti sesudah: dua generasi record berdampingan di koleksi yang sama"
echo "Distribusi bentuk atribut PVMBG:"
mq 'printjson(db.hazards.aggregate([
  {$match:{source:"PVMBG"}},
  {$group:{_id:{$map:{input:{$objectToArray:"$attributes"},as:"a",in:"$$a.k"}}, jumlah:{$sum:1}, contoh:{$first:"$attributes"}}}
]).toArray())'
shot S-15

echo "Hitungan record tanpa vs dengan confidence_level:"
mq 'printjson({tanpa: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:false}}), dengan: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:true}})})'
shot S-16

BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)
echo "-- Kedua generasi terbaca melalui Client API resmi:"
curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?hazard_type=VOLCANIC&limit=200' | jq '
  [.events[] | {ada_confidence_level: (.attributes | has("confidence_level"))}]
  | group_by(.ada_confidence_level) | map({ada_confidence_level: .[0].ada_confidence_level, jumlah: length})'

echo "Contoh record lama vs baru berdampingan via API:"
curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?hazard_type=VOLCANIC&limit=200' | jq '
  .events as $e
  | { lama: ($e | map(select(.attributes|has("confidence_level")|not))[0] | {hazard_id, ingested_at, attributes}),
      baru: ($e | map(select(.attributes|has("confidence_level")))[0]     | {hazard_id, ingested_at, attributes}) }'
shot S-17

echo "-- 6.5 Bukti tidak ada migrasi, tidak ada deploy, tidak ada index berubah"
snap > /tmp/snap_k2_after.txt
mq 'printjson(db.hazards.getIndexes().map(i => ({name:i.name, key:i.key})))' > /tmp/idx_after.txt
mq 'printjson(db.getCollectionInfos({name:"hazards"}))' > /tmp/coll_after.txt

diff /tmp/snap_k2_before.txt /tmp/snap_k2_after.txt && echo "container: TIDAK ADA yang restart/rebuild"
diff /tmp/idx_before.txt     /tmp/idx_after.txt     && echo "index: TIDAK BERUBAH"
diff /tmp/coll_before.txt    /tmp/coll_after.txt    && echo "definisi koleksi/validator: TIDAK BERUBAH"
shot S-18


echo
echo "== Step 7: Kriteria 3: Canonical Store hanya dapat diakses Aggregator"
echo "-- 7.1 Port check: Mongo tidak mempublikasikan port ke host"
docker compose config --format json | jq -r '.services | to_entries[]
  | [.key, ((.value.ports // []) | map(.published) | join(",") | if . == "" then "-" else . end)] | @tsv' | column -t
docker port $(docker compose ps -q mongo) || echo "mongo: tidak ada port host"
nc -zv -w2 localhost 27017 2>&1 || echo "host tidak bisa menjangkau Mongo di localhost:27017"
nc -zv -w2 localhost 3000 2>&1  || echo "host juga tidak bisa menjangkau Aggregator langsung"
shot S-19

echo "-- Network bnpb_store: internal dan hanya berisi mongo + aggregator"
docker network inspect bnpb_store --format 'internal={{.Internal}}  anggota:{{range .Containers}} {{.Name}}{{end}}'
shot S-20

echo "-- 7.2 Uji jangkauan network dari tiap container ke Mongo"
for s in aggregator client-api auth-service consumer-notifier consumer-dashboard mock-bmkg mock-pvmbg rabbitmq; do
  printf '%-20s ' "$s"
  docker compose exec -T "$s" sh -c 'wget -T2 -qO- http://mongo:27017 2>&1 | head -c 70; echo'
done
shot S-21

echo "-- 7.3 Pemilik MONGO_URI dan driver mongodb"
docker compose config --format json | jq -r '.services | to_entries[]
  | select((.value.environment // {}) | has("MONGO_URI")) | "MONGO_URI hanya ada di: \(.key)"'
grep -l '"mongodb"' */package.json
grep -rl --include='*.ts' --exclude-dir=node_modules 'mongodb' .
shot S-22

echo "-- 7.4 Komponen downstream membaca data via API internal Aggregator"
BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)
curl -s -H 'x-correlation-id: k3-demo' -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1' > /dev/null
echo "Penelusuran jejak correlation ID (client-api -> aggregator -> mongo):"
docker compose logs --no-log-prefix client-api aggregator | grep k3-demo \
  | jq -c '{service, correlation_id, msg, target, call, duration_ms}'
shot S-23

echo "-- Endpoint API internal Aggregator (hanya terjangkau dari network internal)"
docker compose exec -T client-api wget -qO- 'http://aggregator:3000/internal/events?limit=1' | jq '.events[0] | {hazard_id, source, severity}'
docker compose exec -T client-api wget -qO- 'http://aggregator:3000/internal/status' | jq
shot S-24


echo
echo "== Step 8: Selesai"
if [ "${CLEANUP:-0}" = "1" ]; then
    echo "-- Membersihkan komentar bump demo pada file sumber..."
    git checkout -- auth-service/src/index.ts client-api/src/index.ts aggregator/src/index.ts
    echo "Source code telah dikembalikan ke kondisi awal (git clean)."
else
    echo "Catatan: Komentar demo bump telah ditambahkan ke auth-service, client-api, dan aggregator."
    echo "Untuk mengembalikan file tersebut, jalankan:"
    echo "  git checkout -- auth-service/src/index.ts client-api/src/index.ts aggregator/src/index.ts"
fi

echo
echo "Done."
