# Grafana 알림 (Discord)

알림 경로는 둘입니다(#14, #15). `prometheus/rules/`의 규칙은 Prometheus UI에서만 보이고, **그래프 이미지가 필요한 알림만** Grafana 관리 규칙(`grafana/provisioning/alerting/rules.yml`)으로 Discord에 보냅니다. 두 곳에 같은 이름의 규칙이 있어도 서로 독립입니다(`ServiceHigh5xxRate`). Alertmanager는 이 작업에 포함하지 않았습니다.

## 파일

| 파일 | 내용 |
|---|---|
| `contact-points.yml` | 연락처 `discord`. 웹훅 주소는 `$__env{DISCORD_WEBHOOK_URL}` |
| `policies.yml` | 루트 정책의 수신자 `discord`, `group_by: [alertname, service]`, `group_wait 30s`, `group_interval 5m`, `repeat_interval 4h` |
| `templates.yml` | 제목 `expo.title`, 본문 `expo.message`(서비스·요약·현재 값·대시보드/패널 링크·런북·silence 링크, 복구 표시) |
| `rules.yml` | `ServiceHigh5xxRate`, `FormOutboxStalled`, `FormDbPoolExhausted` |

루트 정책이 처음부터 Discord이므로 기본 이메일 연락처(SMTP 미설정 오류)로 새지 않습니다. 대기·반복 시간은 노이즈를 본 뒤 조정하세요.

## 웹훅 설정

1. Discord 채널 설정 > 연동 > 웹후크에서 URL을 만듭니다.
2. 서버의 `.env`(커밋 금지)에 `DISCORD_WEBHOOK_URL`을 넣고 Grafana를 재시작합니다. 미설정이면 연결할 수 없는 자리표시 주소가 들어가 Grafana는 뜨지만 전송은 실패합니다.
3. 링크의 기준 주소는 `GRAFANA_ROOT_URL`(기본 `http://127.0.0.1:3001`)입니다. 운영자가 쓰는 터널 주소와 맞추세요.

값은 저장소와 로그에 남기지 않습니다. Grafana는 연락처의 URL을 API에서 `[REDACTED]`로 가립니다.

## 규칙 작성 규약

- 라벨: `severity`(`warning`/`critical`). `service` 라벨은 쿼리 결과에서 옵니다(`by (service)`로 집계). 정책 그룹이 `service`를 쓰므로 빠뜨리지 마세요.
- 주석: `summary`(한 줄), `runbook_url`([docs/runbooks.md](runbooks.md)의 앵커), `__dashboardUid__`와 `__panelId__`(발화 때 해당 패널을 이미지로 첨부하고 템플릿의 패널 링크가 됩니다). 이미지에 쓸 패널은 발화 시점에 값이 보이는 쿼리여야 합니다.
- 조건은 `A`(Prometheus 즉시 쿼리) -> `B`(reduce last) -> `C`(threshold). 템플릿의 "현재 값"은 `B`입니다.
- 새 파일을 추가하거나 고치면 Grafana를 재시작합니다.

## 이미지

`grafana-image-renderer` 컨테이너(외부 publish 없음)가 Chromium으로 패널을 렌더링합니다. Grafana에는 `GF_RENDERING_SERVER_URL`, `GF_RENDERING_CALLBACK_URL`, `GF_UNIFIED_ALERTING_SCREENSHOTS_CAPTURE=true`가 설정됩니다. 렌더러는 메모리를 쓰므로 서버 사양을 확인하세요(측정하지 않음). 수동 렌더: `GET /render/d-solo/<uid>/<slug>?panelId=<id>`.

## 스냅샷

`GF_SNAPSHOTS_EXTERNAL_ENABLED=false`로 외부(snapshots.raintank.io) 공유를 끕니다. 로컬 스냅샷은 이 Grafana에 저장되고 링크로 공유됩니다. 로컬 데모에서 `external:true`는 403, 로컬은 200임을 확인했습니다. 스냅샷에는 쿼리 결과가 들어가므로 외부로 링크를 퍼뜨리지 마세요.

## 로컬 확인

`docker-compose.demo.yml`은 웹훅을 `dev/fake-webhook.mjs`(가짜 서버, `http://fake-services:9999/webhook`)로 돌립니다. 가짜 서비스 `form-1`의 아웃박스 지연이 900초라 약 3~4분 뒤 `FormOutboxStalled`가 발화하고, 웹훅 서버가 PNG 첨부가 있는 multipart 요청을 받습니다(`GET :9999/received`). 실제 Discord로는 보내지 않습니다.
