#!/usr/bin/env bash
set -euo pipefail

promtool() { docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" -v "$PWD/prometheus/rules:/etc/prometheus/rules:ro" prom/prometheus:v2.55.1 "$@"; }
promtool check config /p/prometheus.yml
promtool check rules /p/rules/recording.yml /p/rules/alerts.yml /p/rules/attendance.yml
promtool test rules /p/tests/rules.test.yml /p/tests/attendance.test.yml

# Loki config and Alloy pipeline syntax (Tempo has no offline verify; the demo run covers it).
docker run --rm -v "$PWD/loki:/c:ro" grafana/loki:3.3.2 -config.file=/c/loki.yml -config.expand-env=true -verify-config
docker run --rm -v "$PWD/alloy:/c:ro" grafana/alloy:v1.5.1 fmt /c/config.alloy >/dev/null
