#!/usr/bin/env bash
# 서버(바이너리·pm2)용 Alertmanager 준비. docker-compose가 컨테이너를 시작할 때 해 주는 일을 대신한다(docs/alerting.md "운영 배포").
#   1) 템플릿의 __GRAFANA_ROOT_URL__ 을 실제 주소로 바꿔 렌더링
#   2) alertmanager.yml 의 템플릿 경로와 웹훅 파일 경로를 서버 경로로 바꿈
#   3) prometheus.yml 의 alertmanager 대상(alertmanager:9093)을 127.0.0.1:<포트>로 바꿈
# 사용법: prepare-server.sh <릴리스 디렉터리> <웹훅 파일> <Grafana 기준 URL> <Alertmanager 포트>
#   <릴리스 디렉터리>는 prometheus/ 와 alertmanager/ 를 푼 곳이다.
# 결과: <릴리스>/alertmanager/server/{alertmanager.yml,templates/expo.tmpl}, <릴리스>/prometheus/prometheus.yml 수정
# 웹훅 파일이 없어도 실패하지 않는다. Prometheus·Grafana 배포가 Discord 설정에 묶이지 않게 하려는 것이고, 경고를 남긴다.
# 이 경우 알림은 보낼 때 Alertmanager 로그에 "read webhook_url_file" 오류로 나타난다.
set -euo pipefail

usage() { echo "usage: $0 <release-dir> <webhook-file> <grafana-root-url> <alertmanager-port>" >&2; exit 2; }
[ "$#" -eq 4 ] || usage

RELEASE="$1"; WEBHOOK="$2"; GRAFANA_URL="$3"; PORT="$4"

# sed 의 구분자(|)와 &, \ 가 값에 섞이지 않도록 허용 문자를 좁힌다.
[[ "$WEBHOOK" =~ ^/[A-Za-z0-9._/@+-]+$ ]] || { echo "bad webhook file path: $WEBHOOK" >&2; exit 2; }
[[ "$GRAFANA_URL" =~ ^https?://[A-Za-z0-9._:/-]+$ ]] || { echo "bad grafana root url: $GRAFANA_URL" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || { echo "bad port: $PORT" >&2; exit 2; }
[ -d "$RELEASE/alertmanager" ] || { echo "missing $RELEASE/alertmanager" >&2; exit 1; }
[ -f "$RELEASE/prometheus/prometheus.yml" ] || { echo "missing $RELEASE/prometheus/prometheus.yml" >&2; exit 1; }

RELEASE="$(cd "$RELEASE" && pwd)"
SRC="$RELEASE/alertmanager"
OUT="$SRC/server"
GRAFANA_URL="${GRAFANA_URL%/}"

rm -rf "$OUT"
mkdir -p "$OUT/templates"

# 1) 템플릿
sed "s|__GRAFANA_ROOT_URL__|$GRAFANA_URL|g" "$SRC/templates/expo.tmpl" > "$OUT/templates/expo.tmpl"
if grep -q '__GRAFANA_ROOT_URL__' "$OUT/templates/expo.tmpl"; then
  echo "template still has __GRAFANA_ROOT_URL__" >&2; exit 1
fi

# 2) alertmanager.yml (compose 는 /tmp/templates 에 렌더링하고 비밀은 /run/secrets 에 둔다)
sed -e "s|/tmp/templates/\*\.tmpl|$OUT/templates/*.tmpl|" \
    -e "s|/run/secrets/discord_webhook_url|$WEBHOOK|" \
    "$SRC/alertmanager.yml" > "$OUT/alertmanager.yml"
grep -qF "$OUT/templates/*.tmpl" "$OUT/alertmanager.yml" || { echo "template path was not rewritten" >&2; exit 1; }
grep -qF "$WEBHOOK" "$OUT/alertmanager.yml" || { echo "webhook path was not rewritten" >&2; exit 1; }
if grep -qE '/tmp/templates|/run/secrets' "$OUT/alertmanager.yml"; then
  echo "compose-only path is still in alertmanager.yml" >&2; exit 1
fi

# 3) Prometheus 의 알림 대상
PROM="$RELEASE/prometheus/prometheus.yml"
sed "s|alertmanager:9093|127.0.0.1:$PORT|" "$PROM" > "$PROM.tmp"
mv "$PROM.tmp" "$PROM"
grep -qF "127.0.0.1:$PORT" "$PROM" || { echo "prometheus alerting target was not rewritten" >&2; exit 1; }
if grep -qF 'alertmanager:9093' "$PROM"; then
  echo "prometheus still points at alertmanager:9093" >&2; exit 1
fi

if command -v "${AMTOOL:-amtool}" >/dev/null 2>&1; then
  "${AMTOOL:-amtool}" check-config "$OUT/alertmanager.yml" >/dev/null
fi

if [ ! -s "$WEBHOOK" ]; then
  echo "WARN: webhook file $WEBHOOK is missing or empty; alerts will fail to send until it exists" >&2
fi
echo "alertmanager prepared: config=$OUT/alertmanager.yml prometheus target=127.0.0.1:$PORT"
