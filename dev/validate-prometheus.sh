#!/usr/bin/env bash
set -euo pipefail

promtool() { docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" -v "$PWD/prometheus/rules:/etc/prometheus/rules:ro" prom/prometheus:v2.55.1 "$@"; }
promtool check config /p/prometheus.yml
promtool check rules /p/rules/recording.yml /p/rules/alerts.yml /p/rules/attendance.yml /p/rules/form.yml
promtool test rules /p/tests/rules.test.yml /p/tests/attendance.test.yml /p/tests/form.test.yml

# Loki config and Alloy pipeline syntax (Tempo has no offline verify; the demo run covers it).
docker run --rm -v "$PWD/loki:/c:ro" grafana/loki:3.3.2 -config.file=/c/loki.yml -config.expand-env=true -verify-config
docker run --rm -v "$PWD/alloy:/c:ro" grafana/alloy:v1.5.1 fmt /c/config.alloy >/dev/null

# Alertmanager: the webhook is a dummy file and the Grafana URL is rendered into the template like at container start.
docker run --rm --entrypoint sh -v "$PWD/alertmanager:/a:ro" prom/alertmanager:v0.28.1 -c '
  set -e
  mkdir -p /tmp/s /tmp/templates
  echo http://dummy.invalid/webhook > /tmp/s/url
  sed "s|/run/secrets/discord_webhook_url|/tmp/s/url|" /a/alertmanager.yml > /tmp/am.yml
  sed "s|__GRAFANA_ROOT_URL__|http://127.0.0.1:3001|g" /a/templates/expo.tmpl > /tmp/templates/expo.tmpl
  amtool check-config /tmp/am.yml
  # Grafana-managed alerts must not be delivered twice; others go to discord.
  for a in ServiceHigh5xxRate FormOutboxStalled FormDbPoolExhausted; do
    test "$(amtool config routes test --config.file=/tmp/am.yml alertname=$a severity=warning)" = null
  done
  test "$(amtool config routes test --config.file=/tmp/am.yml alertname=FormOutboxExhausted severity=critical)" = discord
'
