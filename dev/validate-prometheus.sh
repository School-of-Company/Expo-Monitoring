#!/usr/bin/env bash
set -euo pipefail

promtool() { docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" -v "$PWD/prometheus/rules:/etc/prometheus/rules:ro" prom/prometheus:v2.55.1 "$@"; }
promtool check config /p/prometheus.yml
promtool check rules /p/rules/recording.yml /p/rules/alerts.yml /p/rules/attendance.yml
promtool test rules /p/tests/rules.test.yml /p/tests/attendance.test.yml
