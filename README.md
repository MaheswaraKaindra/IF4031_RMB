# IF4031_M1_RMB

Milestone 1 IF4031 Arsitektur Aplikasi Terdistribusi.

## Arsitektur

| Service           | Container            | Port host | Fungsi                                                                      |
| :---------------- | :------------------- | :-------- | :-------------------------------------------------------------------------- |
| Mock BMKG         | `mock-bmkg`          | 8081      | `SeismicEvent` dan `TsunamiWarning`, kredensial `X-BMKG-Key`                |
| Mock PVMBG        | `mock-pvmbg`         | 8082      | `VolcanicReport`, kredensial `Authorization: Bearer`, endpoint admin        |
| Aggregator        | `aggregator`         | tidak ada | Polling BMKG dan PVMBG, pemetaan ke `HazardEvent`, pemilik Canonical Store  |
| Canonical Store   | `mongo`              | tidak ada | MongoDB, hanya dapat dijangkau Aggregator                                   |
| Client-Facing API | `client-api`         | 8080      | `GET /events` untuk client downstream, membaca lewat API Aggregator         |
| Auth Service      | `auth-service`       | 8090      | Menerbitkan access token JWT (RS256) dan refresh token                      |
| Message Broker    | `rabbitmq`           | 15672     | RabbitMQ, exchange fanout `hazard_events` (port host hanya untuk UI, lokal) |
| Notifier          | `consumer-notifier`  | tidak ada | Consumer queue `q_field_notifier`                                           |
| Dashboard Updater | `consumer-dashboard` | tidak ada | Consumer queue `q_dashboard_updater`                                        |
| Portal Regional   | `consumer-portal`    | tidak ada | Consumer ketiga untuk demo P5, tidak berjalan secara default (profile `demo`) |

Port dapat diubah lewat `.env` (lihat [Konfigurasi](#konfigurasi)).

### Isolasi network

| Network   | Anggota                                  |
| :-------- | :--------------------------------------- |
| `store`   | `mongo`, `aggregator` (internal)         |
| `broker`  | `rabbitmq`, `aggregator`, kedua consumer |
| `sources` | `aggregator`, `mock-bmkg`, `mock-pvmbg`  |
| `api`     | `client-api`, `aggregator`               |
| `auth`    | `auth-service`                           |

## Requirements

- [Docker](https://docs.docker.com/get-started/get-docker/) dengan [Docker Compose v2](https://docs.docker.com/compose/install/), atau [Podman](https://podman.io/docs/installation) dengan [podman-compose](https://github.com/containers/podman-compose#installation)
- [OpenSSL](https://openssl-library.org/source/) atau LibreSSL, [curl](https://curl.se/download.html), dan [jq](https://jqlang.org/download/) untuk script
- [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) untuk load test

## Cara menjalankan

1. Buat `.env`, lalu tambahkan seluruh kredensial yang di-generate script.

   ```sh
   cp .env.example .env
   ./scripts/gen-secrets.sh >> .env
   ```

2. Build dan jalankan seluruh service.

   ```sh
   docker compose up -d --build
   ```

3. Tunggu sampai seluruh container berstatus `healthy`.

   ```sh
   docker compose ps
   ```

4. Ambil access token lalu baca event.

   ```sh
   # Muat seluruh variabel .env ke shell sebagai environment variable
   set -a; . ./.env; set +a

   # Login sebagai client bnpb-ops ke Auth Service, simpan access token (berlaku 60 detik)
   BODY=$(jq -n --arg secret "$AUTH_CLIENT_BNPB_OPS_SECRET" \
       '{client_id: "bnpb-ops", client_secret: $secret}')
   TOKEN=$(curl -s -X POST localhost:8090/token \
       -H 'Content-Type: application/json' \
       -d "$BODY" \
       | jq -r .access_token)

   # Baca 5 HazardEvent terbaru dari Client-Facing API memakai token tersebut
   curl -s -H "Authorization: Bearer $TOKEN" 'localhost:8080/events?limit=5' | jq
   ```

## Cara menghentikan

```sh
docker compose down        # data Mongo dan RabbitMQ tetap tersimpan di volume
docker compose down -v     # sekaligus menghapus volume
```

> Password Mongo dan RabbitMQ hanya dipasang saat volume pertama kali dibuat. Jika `MONGO_PASSWORD` atau `RABBITMQ_PASSWORD` diganti, jalankan `docker compose down -v` terlebih dahulu.

## Konfigurasi

Seluruh konfigurasi dibaca dari `.env` di root repositori. Compose hanya meneruskan variabel yang dibutuhkan ke masing-masing container, dan menyusun sendiri URL antar service (`BMKG_URL`, `PVMBG_URL`, `AGGREGATOR_URL`, `MONGO_URI`, `RABBITMQ_URL`) memakai nama service. Variabel URL di `.env.example` hanya dipakai saat service dijalankan tanpa Docker. Setiap service juga memiliki `.env.example` sendiri untuk keperluan tersebut.

Variabel bertanda **secret** di-generate oleh `scripts/gen-secrets.sh`.

> Compose lebih memprioritaskan variabel yang sudah di-export di shell daripada `.env`. Setelah menjalankan `set -a; . ./.env; set +a` lalu mengubah `.env`, buka shell baru (atau `unset` variabel yang diubah) sebelum `docker compose up`, kalau tidak nilai lama tetap dipakai.

### Umum

| Variabel    | Default | Keterangan                                                    |
| :---------- | :------ | :------------------------------------------------------------ |
| `LOG_LEVEL` | `info`  | Level log pino seluruh service (`debug`, `info`, `warn`, ...) |

### Mock BMKG dan PVMBG

| Variabel                   | Default | Keterangan                                                  |
| :------------------------- | :------ | :---------------------------------------------------------- |
| `BMKG_PORT`                | `8081`  | Port mock BMKG                                              |
| `X_BMKG_KEY_SHA256`        | secret  | Hash SHA-256 dari `X_BMKG_KEY`, dipakai mock untuk validasi |
| `BMKG_EVENT_INTERVAL_MS`   | `10000` | Interval kemunculan `SeismicEvent` baru                     |
| `BMKG_WARNING_DELAY_MS`    | `0`     | Bila > 0, `TsunamiWarning` terbit sekian ms **setelah** event-nya (demo late warning) |
| `PVMBG_PORT`               | `8082`  | Port mock PVMBG                                             |
| `PVMBG_TOKEN_SHA256`       | secret  | Hash SHA-256 dari `PVMBG_TOKEN`                             |
| `PVMBG_DELAY_MIN_MS`       | `500`   | Delay respons minimum PVMBG                                 |
| `PVMBG_DELAY_MAX_MS`       | `3000`  | Delay respons maksimum PVMBG                                |
| `PVMBG_REPORT_INTERVAL_MS` | `10000` | Interval kemunculan `VolcanicReport` baru                   |

### Aggregator

| Variabel              | Default | Keterangan                                             |
| :-------------------- | :------ | :----------------------------------------------------- |
| `AGGREGATOR_PORT`     | `3000`  | Port API internal Aggregator (tidak dibuka ke host)    |
| `X_BMKG_KEY`          | secret  | API key BMKG, format `bmkg_<64 hex>`                   |
| `PVMBG_TOKEN`         | secret  | Token PVMBG, format `pvmbg.v1.<43 karakter base64url>` |
| `POLLING_INTERVAL_MS` | `3000`  | Interval polling ke kedua mock                         |

### Client-Facing API

| Variabel                | Default | Keterangan                                                      |
| :---------------------- | :------ | :-------------------------------------------------------------- |
| `CLIENT_API_PORT`       | `8080`  | Port Client-Facing API                                          |
| `AGGREGATOR_TIMEOUT_MS` | `2000`  | Timeout panggilan ke Aggregator                                 |
| `STALE_AFTER_MS`        | `10000` | Batas umur data sebelum sumber ditandai `stale`                 |
| `MAX_IN_FLIGHT`         | `100`   | Batas request bersamaan, kelebihannya dijawab `429`             |
| `JWT_PUBLIC_KEY_B64`    | secret  | Public key RS256 (PEM, base64) untuk memverifikasi access token |

### Auth Service

| Variabel                               | Default           | Keterangan                              |
| :------------------------------------- | :---------------- | :-------------------------------------- |
| `AUTH_PORT`                            | `8090`            | Port Auth Service                       |
| `JWT_PRIVATE_KEY_B64`                  | secret            | Private key RS256 (PEM, base64)         |
| `JWT_ISSUER`                           | `bnpb-auth`       | Claim `iss`, juga dicek oleh client-api |
| `JWT_AUDIENCE`                         | `bnpb-client-api` | Claim `aud`, juga dicek oleh client-api |
| `ACCESS_TOKEN_TTL_SECONDS`             | `60`              | TTL access token                        |
| `REFRESH_TOKEN_TTL_SECONDS`            | `3600`            | TTL refresh token                       |
| `AUTH_MAX_FAILED_ATTEMPTS`             | `10`              | Percobaan gagal per alamat sebelum `/token` dan `/refresh` menjawab `429` |
| `AUTH_FAILURE_WINDOW_SECONDS`          | `60`              | Lebar jendela waktu penghitungan percobaan gagal |
| `AUTH_CLIENT_MEDIA_SECRET_SHA256`      | secret            | Hash secret client `media`              |
| `AUTH_CLIENT_FIELD_TEAM_SECRET_SHA256` | secret            | Hash secret client `field-team`         |
| `AUTH_CLIENT_BNPB_OPS_SECRET_SHA256`   | secret            | Hash secret client `bnpb-ops`           |

### Infrastruktur

| Variabel                   | Default | Keterangan                                     |
| :------------------------- | :------ | :--------------------------------------------- |
| `MONGO_USERNAME`           | `bnpb`  | User root MongoDB                              |
| `MONGO_PASSWORD`           | secret  | Password root MongoDB                          |
| `RABBITMQ_USERNAME`        | `bnpb`  | User RabbitMQ                                  |
| `RABBITMQ_PASSWORD`        | secret  | Password RabbitMQ                              |
| `RABBITMQ_MANAGEMENT_PORT` | `15672` | Port UI RabbitMQ, hanya terikat ke `127.0.0.1` |
| `HEALTH_PORT`              | `8095`  | Port health check consumer di dalam container  |

## API

### Auth Service (`:8090`)

| Endpoint        | Body                             | Keterangan                                                        |
| :-------------- | :------------------------------- | :---------------------------------------------------------------- |
| `POST /token`   | `{"client_id", "client_secret"}` | Menerbitkan `access_token` dan `refresh_token`                    |
| `POST /refresh` | `{"refresh_token"}`              | Menerbitkan pasangan token baru, refresh token lama tidak berlaku |
| `GET /health`   |                                  | Health check                                                      |

Client yang terdaftar:

| `client_id`  | Client                          | Scope                 | Field yang dapat diakses |
| :----------- | :------------------------------ | :-------------------- | :----------------------- |
| `media`      | Media / Pers                    | `events:read:summary` | Ringkasan                |
| `field-team` | Tim Lapangan (BASARNAS / Pemda) | `events:read:raw`     | Ringkasan dan Mentah     |
| `bnpb-ops`   | BNPB Pusat / Internal Ops       | `events:read:raw`     | Ringkasan dan Mentah     |

### Client-Facing API (`:8080`)

`GET /events` dengan header `Authorization: Bearer <access_token>`.

| Query         | Contoh                | Keterangan                                                       |
| :------------ | :-------------------- | :--------------------------------------------------------------- |
| `hazard_type` | `SEISMIC`, `VOLCANIC` | Filter jenis bahaya                                              |
| `severity`    | `NORMAL` ... `AWAS`   | Filter tingkat ancaman                                           |
| `limit`       | `20`                  | Jumlah event, default 50                                         |
| `fields`      | `hazard_id,latitude`  | Field yang diminta. Field Mentah untuk scope Media dijawab `403` |

Respons memuat `events` dan `sources`, yaitu status kebaruan tiap sumber (`last_success_at`, `stale`, `stale_since`). Sebuah sumber ditandai `stale` bila polling terakhirnya gagal (langsung terdeteksi pada polling pertama yang gagal), belum pernah berhasil, atau keberhasilan terakhirnya lebih tua dari `STALE_AFTER_MS`.

Field Ringkasan: `hazard_id`, `source`, `hazard_type`, `severity`, `area_name`, `occurred_at`, `ingested_at`. Field Mentah: `source_ref_id`, `latitude`, `longitude`, `attributes`.

### Mock PVMBG (`:8082`)

Endpoint admin membutuhkan header `Authorization: Bearer $PVMBG_TOKEN`. Setiap panggilan membalik status (toggle).

| Endpoint                     | Keterangan                                    |
| :--------------------------- | :-------------------------------------------- |
| `POST /admin/schema-version` | Menyalakan/mematikan field `confidence_level` |
| `POST /admin/outage`         | Menyalakan/mematikan kondisi outage           |

## Skenario pengujian

Jalankan dari root repositori setelah `docker compose up -d --build` dan seluruh container `healthy`. Siapkan shell terlebih dahulu:

```sh
set -a; . ./.env; set +a
tok() { curl -s -X POST localhost:8090/token -H 'Content-Type: application/json' \
    -d "$(jq -n --arg id "$1" --arg s "$2" '{client_id:$id,client_secret:$s}')"; }
BNPB=$(tok bnpb-ops "$AUTH_CLIENT_BNPB_OPS_SECRET" | jq -r .access_token)   # berlaku 60 detik, ulangi bila kedaluwarsa
```

Endpoint admin PVMBG adalah **toggle**: baca pesan responsnya untuk tahu status saat ini. Jangan merestart mock di tengah demo, karena toggle schema dan outage kembali ke default.

| # | Skenario | Perintah | Hasil yang diharapkan |
| :-- | :-- | :-- | :-- |
| 1 | Pemetaan benar (P1) | `curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=10' \| jq '.events[] \| {source,severity,area_name,latitude,longitude,attributes}'` | Severity sesuai aturan, koordinat gunung terisi dari tabel referensi, `attributes` memuat field sumber |
| 2 | Perubahan skema saat berjalan (P1) | `curl -s -X POST localhost:8082/admin/schema-version -H "Authorization: Bearer $PVMBG_TOKEN"`, tunggu 20 detik, lalu `curl -s -H "Authorization: Bearer $BNPB" 'localhost:8080/events?hazard_type=VOLCANIC&limit=3' \| jq '.events[].attributes'` | Event baru memuat `attributes.confidence_level`, tidak ada container yang restart |
| 3 | Record lama dan baru berdampingan (P1, P4) | `docker compose exec mongo mongosh -u "$MONGO_USERNAME" -p "$MONGO_PASSWORD" --authenticationDatabase admin bnpb_canonical_store --quiet --eval 'printjson({tanpa: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:false}}), dengan: db.hazards.countDocuments({source:"PVMBG","attributes.confidence_level":{$exists:true}})})'` | Kedua hitungan > 0, tidak ada langkah migrasi |
| 4 | Late warning | `BMKG_WARNING_DELAY_MS=6000 BMKG_EVENT_INTERVAL_MS=3000 docker compose up -d --no-deps mock-bmkg`, tunggu 40 detik, lalu `docker compose logs aggregator \| grep 'Late tsunami warning'` dan `docker compose logs consumer-notifier \| grep 'SENDING EMERGENCY'` | Event tersimpan dengan severity dari magnitudo, naik setelah warning terbit, dan notifier memberi peringatan lagi. Kembalikan dengan `docker compose up -d --no-deps mock-bmkg` tanpa variabel |
| 5 | Outage PVMBG (P2) | `curl -s -X POST localhost:8082/admin/outage -H "Authorization: Bearer $PVMBG_TOKEN"`, tunggu 5 detik, lalu `curl -s -w '\nHTTP %{http_code}\n' -H "Authorization: Bearer $BNPB" 'localhost:8080/events?hazard_type=VOLCANIC&limit=3' \| jq .sources` | HTTP 200, `sources.PVMBG.stale = true` dengan `stale_since`, event vulkanik terakhir tetap dikembalikan, request seismik normal. Matikan outage dengan perintah yang sama, sumber kembali `stale = false` tanpa restart |
| 6 | Load test 3 detik (P2) | Set `PVMBG_DELAY_MIN_MS=3000` dan `PVMBG_DELAY_MAX_MS=3000` di `.env` **sebelum start pertama**, lalu `k6 run --summary-export load-test/results/run-delay3s.json -e CLIENT_SECRET="$AUTH_CLIENT_BNPB_OPS_SECRET" load-test/events.js` | 25 VU BMKG-only dan 25 VU vulkanik selama 60 detik, p95 BMKG-only < 300 ms, `http_req_failed` < 1% |
| 7 | Load test saat outage (P2) | Jalankan skenario 5 (nyalakan outage), lalu perintah k6 skenario 6 | `stale_volcanic` mendekati 100%, tidak ada error, p95 BMKG-only tetap < 300 ms |
| 8 | Penolakan terkendali 429 (P2) | `MAX_IN_FLIGHT=5 docker compose up -d --no-deps client-api`, lalu `k6 run -e VUS_EACH=100 -e DURATION=20s -e CLIENT_SECRET="$AUTH_CLIENT_BNPB_OPS_SECRET" load-test/events.js`, kembalikan dengan `docker compose up -d --no-deps --force-recreate client-api` | `rejected_429` > 0 dilaporkan, `http_req_failed` < 1%, service tetap hidup |
| 9 | Isolasi kredensial (P3) | `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $X_BMKG_KEY" localhost:8082/volcanic-reports` dan `curl -s -o /dev/null -w '%{http_code}\n' -H "X-BMKG-Key: $PVMBG_TOKEN" localhost:8081/seismic-events` | Keduanya 401. Kredensial sendiri (`X-BMKG-Key: $X_BMKG_KEY`, `Authorization: Bearer $PVMBG_TOKEN`) dijawab 200 |
| 10 | Media hanya Ringkasan (P3) | `MEDIA=$(tok media "$AUTH_CLIENT_MEDIA_SECRET" \| jq -r .access_token)`, lalu `curl -s -H "Authorization: Bearer $MEDIA" 'localhost:8080/events?limit=2' \| jq '.events[0] \| keys'` dan `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $MEDIA" 'localhost:8080/events?fields=latitude'` | 7 field Ringkasan saja. Permintaan field Mentah dijawab 403. `field-team` dan `bnpb-ops` mendapat 11 field |
| 11 | Token kedaluwarsa dan refresh (P3) | `R=$(tok field-team "$AUTH_CLIENT_FIELD_TEAM_SECRET")`, simpan `access_token` dan `refresh_token`, tunggu 65 detik, panggil `/events` lalu `curl -s -X POST localhost:8090/refresh -H 'Content-Type: application/json' -d '{"refresh_token":"<refresh_token>"}'` | `/events` dijawab 401 `token_expired`, refresh menghasilkan token baru (200), refresh token lama ditolak (401). Memakai refresh token lama lagi mencabut seluruh keluarganya |
| 11b | Pembatasan percobaan login gagal (P3) | `for i in $(seq 1 15); do curl -s -o /dev/null -w '%{http_code} ' -X POST localhost:8090/token -H 'Content-Type: application/json' -d '{"client_id":"bnpb-ops","client_secret":"salah"}'; done` | 10 kali `401`, lalu `429` dengan header `Retry-After`. Kembali normal setelah jendela berlalu |
| 12 | Restart satu container (P4) | `docker compose build client-api && docker compose up -d --no-deps client-api`, bandingkan `docker inspect -f '{{.Name}} {{.State.StartedAt}}' $(docker compose ps -q)` sebelum dan sesudah | Hanya `client-api` yang waktu startnya berubah, polling dan consumer terus berjalan. Restart `auth-service`: token yang sudah terbit tetap diterima Client API |
| 13 | Hanya Aggregator yang menjangkau store (P4) | `docker compose exec client-api sh -c 'nc -zv -w2 mongo 27017 \|\| echo tidak bisa menjangkau mongo'` dan `docker network inspect bnpb_store --format '{{.Internal}} {{range .Containers}}{{.Name}} {{end}}'` | Client API tidak dapat menjangkau `mongo`. Network `store` bersifat internal dan hanya berisi `mongo` dan `aggregator`. `MONGO_URI` hanya ada di `aggregator` |
| 14 | Dua consumer independen, hentikan satu (P5) | `docker compose stop consumer-notifier`, tunggu 30 detik, lihat antrean di `http://127.0.0.1:15672` (atau `curl -s -u "$RABBITMQ_USERNAME:$RABBITMQ_PASSWORD" localhost:15672/api/queues/%2F/q_field_notifier \| jq '{messages_ready,consumers}'`), lalu `docker compose start consumer-notifier` | Aggregator tetap mempublikasikan, dashboard tetap menerima, backlog `q_field_notifier` bertambah lalu habis diproses setelah consumer kembali |
| 15 | Consumer ketiga tanpa mengubah producer (P5) | `docker compose --profile demo up -d --build consumer-portal`, lalu `docker compose logs -f consumer-portal` | Consumer baru langsung menerima event, container `aggregator` tidak berubah dan tidak restart |
| 16 | Health dan correlation ID | `for p in 8080 8081 8082 8090; do curl -s localhost:$p/health; echo; done`, lalu `curl -s -D - -o /dev/null -H 'x-correlation-id: demo-123' -H "Authorization: Bearer $BNPB" 'localhost:8080/events?limit=1'` dan `docker compose logs client-api aggregator \| grep demo-123` | Semua service sehat. ID yang sama muncul di log client-api dan aggregator, panggilan keluar memuat `duration_ms` |

Port RabbitMQ management dapat diubah lewat `RABBITMQ_MANAGEMENT_PORT` di `.env`.

## Observability

- Setiap service menyediakan `GET /health`. Consumer menyediakannya di `HEALTH_PORT` di dalam container dan menjawab `503` bila koneksi ke broker terputus.
- Log ditulis sebagai JSON (pino) ke stdout dan memuat `correlation_id`:
  - Request client: header `x-correlation-id` diteruskan dari client-api ke Aggregator. Bila tidak dikirim, client-api men-generate dan mengembalikannya di header respons.
  - Polling: setiap siklus memiliki ID `poll-<uuid>` yang dikirim ke kedua mock lewat header dan ke consumer lewat properti `correlationId` pada pesan RabbitMQ.
- Setiap panggilan keluar dicatat dengan `target`, `call`, dan `duration_ms`.

## Run dev tanpa Docker

Setiap service dapat dijalankan langsung dengan Node.js:

```sh
cd <service>
npm ci
set -a; . ../.env; set +a   # service tidak memuat .env sendiri
npm run dev                 # consumers: npm run dev:notifier atau npm run dev:dashboard
```

Daftar variabel tiap service ada di `.env.example` masing-masing. MongoDB dan RabbitMQ harus tersedia di `localhost`.

## Asumsi dan batasan yang disadari

- Bila satu event BMKG memiliki beberapa `TsunamiWarning`, warning terkuat yang dipakai (Awas mengalahkan Siaga dan Waspada, sesama kuat dipilih yang terbit paling akhir). Warning yang lebih lemah dan datang belakangan tidak menurunkan severity.
- Field sumber yang berubah tipe (misalnya angka menjadi teks) disimpan apa adanya di `attributes`. Field yang dihapus atau diganti nama pada field yang dipetakan (`alert_level`) membuat record itu dilewati dan dicatat di log, tanpa menghentikan record lain.
- Percobaan gagal ke `/token` dan `/refresh` dibatasi per alamat dan disimpan di memori, sehingga client di balik NAT yang sama berbagi batas dan batas hilang saat Auth Service restart.

- Refresh token disimpan di memori Auth Service: restart Auth Service membuat seluruh sesi refresh harus login ulang, dan tidak dapat dipakai dengan beberapa instance (M2).
- Access token yang lama tetap berlaku sampai `exp` (maksimal 60 detik) setelah refresh, karena JWT bersifat stateless. Yang langsung ditolak adalah refresh token yang lama.
- `/internal/*` pada Aggregator tidak memakai autentikasi, hanya terlindungi network `api`.
- Event yang gagal dipublikasikan karena broker mati ditampung di memori Aggregator dan dikirim setelah koneksi pulih. Jika Aggregator sendiri restart saat broker mati, event tersebut tidak terkirim (datanya tetap ada di store).
- Restart mock mengembalikan toggle schema dan outage ke default. Id record baru unik per proses, sehingga tidak menimpa data yang sudah tersimpan.
- Aggregator memakai user root MongoDB. Kedua consumer berbagi satu folder `consumers/` dan satu Dockerfile, dibangun sebagai dua service.

## Penggunaan LLM

Sebagian kode dan dokumentasi ditulis dengan bantuan LLM (Claude Code). Penggunaannya dideklarasikan pada laporan beserta Form Penggunaan AI.
