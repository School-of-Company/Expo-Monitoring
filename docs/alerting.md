# 알림 (Alertmanager와 Grafana, Discord)

알림 경로는 둘입니다(#14, #15).

1. **기본 경로**: `prometheus/rules/*.yml` -> Alertmanager -> Discord. 규칙을 추가하면 자동으로 Discord에 갑니다. 이 문서의 "Alertmanager" 절.
2. **그래프 이미지 변형**: Grafana 관리 규칙(`grafana/provisioning/alerting/rules.yml`) 3개(`ServiceHigh5xxRate`, `FormOutboxStalled`, `FormDbPoolExhausted`)는 발화 시 패널 PNG를 붙여 Discord로 보냅니다. 이 문서의 "Grafana 알림" 절.

## 중복 방지 (같은 조건이 Discord에 두 번 오지 않게)

선택: **Alertmanager 루트 라우트에서 위 3개 알림 이름을 `null` 수신자로 보냅니다**(`alertmanager/alertmanager.yml`의 첫 하위 라우트). 그리고 Prometheus 쪽에는 `FormOutboxStalled`·`FormDbPoolExhausted` 규칙을 아예 만들지 않았습니다(`prometheus/rules/form.yml`). `ServiceHigh5xxRate`는 공통 규칙(`alerts.yml`)이 이미 있어서 Prometheus UI에는 계속 보이지만 Discord로는 Grafana 것만 갑니다.

이유: 가장 단순합니다. 규칙 파일을 지우거나 이름을 바꾸지 않고, 억제 규칙(inhibit)처럼 조건이 얽히지도 않습니다. 새 이미지 변형을 추가할 때는 Grafana 규칙의 `title`과 같은 이름을 `alertname=~"..."` 목록에 더하면 됩니다(Prometheus 쪽에 같은 이름의 규칙이 없다면 목록 추가도 필요 없습니다).

대가: Grafana가 죽으면 이 3개는 Discord로 오지 않습니다(Prometheus UI에서만 `ServiceHigh5xxRate`가 보임). `FormOutboxStalled`·`FormDbPoolExhausted`는 Prometheus 쪽 규칙이 없어 Grafana 의존입니다. `dev/validate-prometheus.sh`가 `amtool config routes test`로 이 3개가 `null`로 가는지 CI에서 검사합니다.

## Alertmanager

| 파일                               | 내용                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `alertmanager/alertmanager.yml`    | 라우트, 수신자 `discord`(`discord_configs`), 중복 방지용 `null` 라우트                                    |
| `alertmanager/templates/expo.tmpl` | 제목 `expo.title`, 본문 `expo.message`(서비스·인스턴스·요약·대시보드 링크·런북 링크, 복구는 `[RESOLVED]`) |

제안값(노이즈를 본 뒤 조정): `group_by [alertname, service]`, `group_wait 30s`, `group_interval 5m`, `repeat_interval` — `severity=warning` **4h**, `severity=critical` **1h**(경고는 길게 해서 처음 켤 때의 소음을 줄임). `send_resolved: true`. 심각도가 없는 알림은 기본 4h로 `discord`에 갑니다. 심각도별로 채널을 나누지는 않았고(웹훅 하나) 주기만 다릅니다.

본문 링크: 대시보드는 규칙의 `dashboard_uid` 주석(없으면 `msa-overview`)과 `GRAFANA_ROOT_URL`, 런북은 `runbook_url` 주석입니다. Alertmanager는 설정의 환경 변수를 치환하지 않으므로 컨테이너가 시작할 때 `sed`로 템플릿의 `__GRAFANA_ROOT_URL__`을 바꿔 `/tmp/templates/expo.tmpl`로 씁니다(웹훅 아님).

### 웹훅 주입 방식

`discord_configs.webhook_url_file`로 파일에서 읽습니다. Compose는 `.env`의 `DISCORD_WEBHOOK_URL`을 compose secret(`environment` 소스)으로 만들어 `/run/secrets/discord_webhook_url`에 마운트합니다(Grafana와 같은 변수·같은 채널 공유).

- 확인한 것(마커 문자열을 웹훅 값으로 넣고 `docker logs`, `docker inspect`, `/api/v2/status`, 컨테이너 `env`·`/proc/1/environ`, 저장소 파일을 grep): **Alertmanager 컨테이너에서는 어디에도 나오지 않습니다.** 설정과 `/api/v2/status`에는 파일 경로만 있고, 전송 실패 로그의 URL은 Alertmanager가 `<redacted>`로 가립니다.
- 단 **Grafana 컨테이너는 같은 `DISCORD_WEBHOOK_URL`을 환경 변수(`$__env{...}`)로 받으므로 `docker inspect`에 웹훅이 보입니다**(기존 방식). 호스트에서 `docker compose config`를 실행해도 이 값이 출력됩니다. Docker 권한이 있는 사람과 그 출력이 남는 로그에 노출될 수 있습니다.
- `DISCORD_WEBHOOK_URL`이 **비어 있으면** secret 파일이 마운트되지 않지만 Alertmanager는 **정상 기동**합니다(기동 시 경고 없음). 알림을 전송할 때에야 `read webhook_url_file: open /run/secrets/discord_webhook_url: no such file or directory` 오류가 로그에 남고 전송은 실패합니다. 서버 `.env`에 꼭 설정하세요.

### 운영 배포 (미정)

**운영 서버 배포 방식은 아직 정해지지 않았습니다.** `deploy.yml`은 `prometheus/`, `grafana/`만 올리고 `alertmanager/`는 포함하지 않으며 이번 변경에서도 바꾸지 않았습니다. 이 저장소가 제공하는 것은 Compose(개발·검증용)와 아래 절차입니다. 서버가 바이너리/pm2 환경이라면:

1. Alertmanager 바이너리(v0.28.1 권장, 검증 버전)를 받고 `alertmanager.yml`, `templates/expo.tmpl`을 서버에 둡니다.
2. 웹훅을 파일로 둡니다(권한 600, 저장소 밖): `/srv/.../secrets/discord_webhook_url`. `alertmanager.yml`의 `webhook_url_file`을 그 경로로 바꾸거나 `/run/secrets/discord_webhook_url`에 맞춥니다.
3. 템플릿에서 Grafana 주소를 렌더링합니다: `sed "s|__GRAFANA_ROOT_URL__|http://127.0.0.1:3001|g" expo.tmpl > /tmp/templates/expo.tmpl` (`templates:` 경로와 일치시킴).
4. pm2: `pm2 start alertmanager -- --config.file=alertmanager.yml --storage.path=<데이터 경로> --web.listen-address=127.0.0.1:9093 --cluster.listen-address=`.
5. `prometheus.yml`의 `alerting.alertmanagers` 대상은 `alertmanager:9093`입니다. 바이너리 환경이면 `127.0.0.1:9093`으로 바꿔야 합니다(이 변환을 배포 스크립트가 하는지 미확인).
6. 데이터 디렉터리(silence·알림 기록)를 릴리스 교체 때 보존합니다.

필요한 환경: 웹훅 파일, `GRAFANA_ROOT_URL`(링크 기준, 기본 `http://127.0.0.1:3001`). 서버 Docker 사용 가능 여부는 미확인입니다.

### Prometheus 규칙 규약

- 라벨 `severity`(`warning`/`critical`), `service`는 Eureka 라벨로 자동 붙습니다. 이미 있는 규칙(`ServiceDown`, `alerts.yml`의 일부)은 `summary`만 있고 `runbook_url`이 없어 본문에 런북 링크 없이 갑니다.
- 주석: `summary`, `description`, `runbook_url`([런북](runbooks.md) 앵커), `dashboard_uid`(대시보드 링크).
- 앱 지표에 `service` 라벨이 겹치면(예: `form_downstream_calls_seconds{service="expo|user"}`) Eureka 라벨이 이기고 앱의 값은 `exported_service`로 바뀝니다.
- 규칙은 Form 서버 코드(`src/metrics`)의 이름·라벨로 만들었고 `prometheus/tests/form.test.yml`로 단위 테스트합니다.

### 로컬 확인

`docker-compose.demo.yml`은 `dev/alertmanager.demo.yml`(짧은 대기·반복 시간)로 Alertmanager를 띄우고 웹훅은 가짜 서버(`/alertmanager` 경로)로 보냅니다. `dev/verify-alertmanager.mjs`가 발화·그룹·반복·복구·중복 없음을 확인합니다(약 10분, CI 제외, 사용법은 파일 머리말).

## Grafana 알림 (Discord)

## 파일

| 파일                 | 내용                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `contact-points.yml` | 연락처 `discord`. 웹훅 주소는 `$__env{DISCORD_WEBHOOK_URL}`                                                                 |
| `policies.yml`       | 루트 정책의 수신자 `discord`, `group_by: [alertname, service]`, `group_wait 30s`, `group_interval 5m`, `repeat_interval 4h` |
| `templates.yml`      | 제목 `expo.title`, 본문 `expo.message`(서비스·요약·현재 값·대시보드/패널 링크·런북·silence 링크, 복구 표시)                 |
| `rules.yml`          | `ServiceHigh5xxRate`, `FormOutboxStalled`, `FormDbPoolExhausted`                                                            |

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
