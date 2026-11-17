#!/usr/bin/env bash
# alertmanager/prepare-server.sh 의 변환 결과를 확인한다. Docker 와 네트워크가 필요 없다.
set -euo pipefail
cd "$(dirname "$0")/.."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }

new_release() {
  rm -rf "$TMP/rel"
  mkdir -p "$TMP/rel/prometheus"
  cp -R alertmanager "$TMP/rel/alertmanager"
  cp prometheus/prometheus.yml "$TMP/rel/prometheus/prometheus.yml"
}

# 정상: 세 군데가 서버 값으로 바뀐다
new_release
printf 'http://example.invalid/hook' > "$TMP/webhook"
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/webhook" "http://127.0.0.1:3001/" 26120 2>"$TMP/err" >/dev/null
[ ! -s "$TMP/err" ] || fail "unexpected warning: $(cat "$TMP/err")"
OUT="$TMP/rel/alertmanager/server"
grep -q "Dashboard: http://127.0.0.1:3001/d/" "$OUT/templates/expo.tmpl" || fail "grafana url not rendered"
! grep -q '__GRAFANA_ROOT_URL__' "$OUT/templates/expo.tmpl" || fail "placeholder left in template"
grep -qF "$(cd "$TMP/rel" && pwd)/alertmanager/server/templates/*.tmpl" "$OUT/alertmanager.yml" || fail "template path"
grep -qF "$TMP/webhook" "$OUT/alertmanager.yml" || fail "webhook path"
! grep -qE '/tmp/templates|/run/secrets' "$OUT/alertmanager.yml" || fail "compose path left"
grep -qF '127.0.0.1:26120' "$TMP/rel/prometheus/prometheus.yml" || fail "prometheus target"
! grep -qF 'alertmanager:9093' "$TMP/rel/prometheus/prometheus.yml" || fail "old prometheus target left"
# 원본(저장소 파일)은 바뀌지 않는다
grep -qF 'alertmanager:9093' prometheus/prometheus.yml || fail "source prometheus.yml was modified"
echo "PASS rewrite"

# 같은 릴리스에 다시 실행해도 같은 결과다(재시도·재배포)
new_release
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/webhook" "http://127.0.0.1:3001" 26120 >/dev/null 2>&1
cp "$TMP/rel/prometheus/prometheus.yml" "$TMP/first.yml"
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/webhook" "http://127.0.0.1:3001" 26120 >/dev/null 2>&1 || fail "second run failed"
cmp -s "$TMP/first.yml" "$TMP/rel/prometheus/prometheus.yml" || fail "second run changed prometheus.yml"
echo "PASS idempotent"

# 웹훅 파일이 없으면 경고만 하고 성공한다
new_release
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/missing" "http://127.0.0.1:3001" 26120 2>"$TMP/err" >/dev/null
grep -q '^WARN: webhook file' "$TMP/err" || fail "missing webhook should warn"
echo "PASS missing webhook warns"

# 잘못된 입력은 거절한다
new_release
for bad in "relative/path" "/tmp/a b" '/tmp/a|b'; do
  bash alertmanager/prepare-server.sh "$TMP/rel" "$bad" "http://127.0.0.1:3001" 26120 >/dev/null 2>&1 && fail "accepted webhook path: $bad"
done
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/webhook" 'http://x/&y' 26120 >/dev/null 2>&1 && fail "accepted url with &"
bash alertmanager/prepare-server.sh "$TMP/rel" "$TMP/webhook" "http://127.0.0.1:3001" abc >/dev/null 2>&1 && fail "accepted bad port"
echo "PASS bad input rejected"
