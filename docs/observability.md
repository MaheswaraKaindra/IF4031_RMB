# Observability contract (K8S-03)

Infra is deployed by `k8s/observability` (Prometheus, Grafana, Jaeger; all `role=other`, 128Mi/256Mi). **Services must still be
instrumented**: today none exposes `/metrics` or emits spans, so the Grafana panels stay empty until each owner adds the following.

## Metrics (Prometheus text format on `/metrics`)
* `http_requests_total{service,method,route,status}` counter; `http_request_duration_seconds{service,route}` histogram.
* Opt in with pod annotations: `prometheus.io/scrape: "true"`, `prometheus.io/port: "<port>"`.
* Domain metrics worth adding: poll duration/outcome per source, outbox/inbox depth, consumer lag, DLQ size, critical notification latency,
  storage `unavailable` outcomes, `leader_epoch`.
* Memory against the Appendix B limit comes from cAdvisor (already scraped, panel 5).

## Traces (OpenTelemetry)
Export OTLP/HTTP to `http://jaeger:4318`. Propagate `traceparent`; keep `x-correlation-id` as a span attribute and in every log line (Pino) so
one request can be followed client-api -> aggregator -> store -> broker -> consumer.

## Logs
Pino JSON with `correlation_id`, plus `trace_id`, `service`, `pod`, `node`, `duration_ms`, `error_code` (see the team design doc, K8s section).

## Access
`kubectl -n sistem-informasi-kebencanaan-bnpb port-forward svc/grafana 3000:3000` and `svc/jaeger 16686:16686`. Analytics (P1) is separate: `/analytics` on the aggregator.
