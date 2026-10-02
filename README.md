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

Respons memuat `events` dan `sources`, yaitu status kebaruan tiap sumber (`last_success_at`, `stale`, `stale_since`).

Field Ringkasan: `hazard_id`, `source`, `hazard_type`, `severity`, `area_name`, `occurred_at`, `ingested_at`. Field Mentah: `source_ref_id`, `latitude`, `longitude`, `attributes`.

### Mock PVMBG (`:8082`)

Endpoint admin membutuhkan header `Authorization: Bearer $PVMBG_TOKEN`. Setiap panggilan membalik status (toggle).

| Endpoint                     | Keterangan                                    |
| :--------------------------- | :-------------------------------------------- |
| `POST /admin/schema-version` | Menyalakan/mematikan field `confidence_level` |
| `POST /admin/outage`         | Menyalakan/mematikan kondisi outage           |

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
