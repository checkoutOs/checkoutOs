# Scraping checkoutOs

checkoutOs exposes one Prometheus-format endpoint, `:9464/metrics` (see [docs/metrics.md](../../docs/metrics.md)). The configs here are for four common consumers. None of them needs any change to checkoutOs.

| File | Consumer | Checked with |
|---|---|---|
| [`prometheus.yml`](prometheus.yml) | Prometheus | `promtool check config` |
| [`config.alloy`](config.alloy) | Grafana Alloy → any remote-write store | `alloy validate` |
| [`datadog-openmetrics.yaml`](datadog-openmetrics.yaml) | Datadog Agent `openmetrics` check | YAML parse only (no offline validator) |
| [`otel-collector.yaml`](otel-collector.yaml) | OpenTelemetry Collector `prometheus` receiver | `otelcol-contrib validate` |

To try them, start the local stack with `docker compose --profile metrics up` (Prometheus + Grafana) or `docker compose --profile observability up` (adds Loki + Alloy). See `observability/docker-compose.observability.yml`.

When checkoutOs runs with `METRICS_AUTH_TOKEN`, enable the commented bearer-token block in your consumer's config. Keep the scrape job named `checkoutos`, because the starter alerts in `../prometheus/alerts.yml` match `up{job="checkoutos"}`.
