# Observability (K8S-03)

Infra is deployed by `k8s/observability` (Prometheus, Grafana, Jaeger; all `role=other`, 128Mi/256Mi). Services are instrumented; this page says what
exists, how to reach it and what is not covered.

## Metrics (Prometheus text format on `/metrics`)
* Scraped through pod annotations (`prometheus.io/scrape: "true"`, `prometheus.io/port`): aggregator, client-api, auth-service, the three consumers, both mocks,
  RabbitMQ (port 15692) and one MongoDB exporter per shard (`k8s/store/mongo-exporter.yaml`). Measured on the 3-VM cluster: 21 of 21 pod targets up, plus cAdvisor
  for memory against the Appendix B limits.
* HTTP: `http_requests_total{service,method,route,status}` and `http_request_duration_seconds{service,route}`.
* Domain metrics: leader and epoch per source, poll duration and outcome, inbox/outbox depth and parked messages, replay counters, RabbitMQ backlog and members,
  MongoDB member state, replication lag and opcounters, coastal sensor requests, circuit breaker state, critical alert delivery latency, satellite offset
  lag, committed offset, active fires and ingest-to-store latency.

## Dashboards (Grafana, provisioned from `k8s/observability/dashboards/`)
| Dashboard | Panels | Use |
|---|---|---|
| BNPB overview | 6 | throughput, error rate, p95, 429, memory |
| BNPB coordination, broker and store | 11 | leader and epoch, poll duration, inbox/outbox, RabbitMQ, Mongo members, replication lag |
| BNPB satellite pipeline (P4) | 8 | source offset lag, committed offset, fires, ingest-to-store p95 |
| BNPB coastal resilience (P5) | 12 | sensor requests, breaker, freshness, critical alert latency |

## Traces (OpenTelemetry)
OTLP/HTTP to `http://jaeger:4318`; `traceparent` is propagated and `x-correlation-id` is a span attribute and in every log line, so one request can be followed
client-api -> aggregator -> consumers. The store write (`store ingest`, `store accept field report`) and the broker publish (`broker publish`, `broker publish field report`) are spans of their own, so one request shows every hop with its timing (example in `docs/evidence/pc-run-phase2.md`). **Not covered:** the mocks, MongoDB itself, RabbitMQ itself and the sensor image emit no spans (third-party or too thin to instrument); inside MongoDB and the broker the time is only visible as the duration of the span that calls them.

## Logs
Pino JSON with `correlation_id`, plus `trace_id`, `service`, `pod`, `node`, `duration_ms`, `error_code`.

## Access
`kubectl -n sistem-informasi-kebencanaan-bnpb port-forward svc/grafana 3000:3000` and `svc/jaeger 16686:16686`. Analytics (P1) is separate: `/analytics` on the aggregator (NodePort 30000).
