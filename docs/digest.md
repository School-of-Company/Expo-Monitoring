# 일일·주간 요약 (digest)

Prometheus·Grafana·Loki를 읽어 Discord 웹훅으로 하루/한 주 요약을 보내는 도구입니다(`digest/`, 외부 패키지 없는 Node 22 ESM). 알림(발화)과 달리 "어제/지난주 한눈에" 용도입니다.

## 무엇을 보내는지

| 구역 | 출처 | 내용 |
|---|---|---|
| 판정·핵심 수치 | Prometheus | 이상 없음/주의/위험 한 줄 + 요청 수, 5xx 비율, 최대 p95, 인스턴스 up. 주간은 지난주 대비 증감(예: 5xx +0.30%p) |
| 알림 | Grafana, Prometheus | Grafana 규칙 정상/대기/발화/오류 건수, 발화 중·기간 내 발화 규칙, Prometheus `ALERTS` 발화 |
| 5xx 비율·p95 상위 N | Prometheus | 서비스별 상위 5개(주간은 지난주 값 병기) |
| 오류 로그 유형 | Loki (선택) | `level=error` 로그를 메시지 앞부분으로 묶은 횟수 상위 N |
| 인스턴스·Form | Prometheus | down 인스턴스, `form_outbox_records`, `form_outbox_oldest_pending_age_seconds`, `form_db_pool_connections{state="waiting"}` (지표가 없으면 줄 생략) |
| 최근 배포 | Grafana | `tags=deploy` 주석 |
| 링크·이미지 | Grafana | 로컬 스냅샷 링크(`external` 끔, 실패 시 대시보드 링크), 패널 PNG 최대 2장(기본 패널 8 5xx 비율, 10 p95) |

집계 구간은 실행 시각 기준 직전 24시간(일일) / 7일(주간)이고, 주간 비교는 그 직전 7일입니다. 서비스별 요청 수는 `increase(http_server_requests_seconds_count[구간])`(Gateway는 `gateway_http_requests_total`)에서 계산하므로 recording rule의 1분 값이 아니라 구간 전체 값입니다.

## 실행

```bash
node digest/index.mjs once daily --dry-run   # 전송 없이 JSON payload + 마크다운 미리보기 (스냅샷 생성도 생략, 패널 렌더는 수행)
node digest/index.mjs once weekly            # 한 번 전송
node digest/index.mjs serve                  # 스케줄러 (기본 매일 09:00, 매주 MON 09:00, Asia/Seoul)
node --test digest/                          # 단위 테스트
node dev/verify-digest.mjs                   # 가짜 Prometheus/Grafana/Loki/Discord 통합 검증
```

컨테이너로는 오버레이 파일을 씁니다. 기존 `docker-compose.yml`은 수정하지 않습니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.digest.yml up -d --build digest
```

환경변수는 `.env`에서 읽고(`.env.example`의 digest 구역 참고), 값이 비어 있으면 기본값을 씁니다. 스케줄러는 다음 실행 시각을 매번 현재 시계로 다시 계산하고 최대 1시간 단위로 깨어나 확인하므로 오래 떠 있어도 오차가 쌓이지 않습니다. `DIGEST_DAILY_AT=off` 또는 `DIGEST_WEEKLY_AT=off`로 하나를 끌 수 있습니다.

## 환경변수

| 변수 | 기본값 | 설명 |
|---|---|---|
| `PROMETHEUS_URL` | (컨테이너: `http://prometheus:9090`) | 필수 |
| `GRAFANA_URL` | (컨테이너: `http://grafana:3000`) | 비우면 알림·배포·스냅샷·이미지 생략 |
| `GRAFANA_TOKEN` | - | Viewer 서비스 계정 토큰(Bearer). 스냅샷 생성은 Editor 권한이 필요할 수 있음(미확인) |
| `GRAFANA_USER` / `GRAFANA_PASSWORD` | - | 토큰이 없을 때 기본 인증 |
| `GRAFANA_PUBLIC_URL` | `GRAFANA_URL` | 본문 링크용 주소(사람이 여는 주소). 내부 주소와 다를 때 설정 |
| `LOKI_URL` | - | 비우면 로그 구역 생략 |
| `DIGEST_LOKI_QUERY` | `{level="error"}` | LogQL 선택자. 실제 라벨은 수집 설정에 맞춤 |
| `DIGEST_LOKI_LIMIT` | `1000` | 가져올 로그 줄 상한(표본). 도달하면 "표본 상한 도달" 표시 |
| `DISCORD_WEBHOOK_URL` | - | 전송 대상. 로그·오류·출력에 남기지 않음 |
| `DIGEST_TZ` | `Asia/Seoul` | 스케줄·표시 시간대 |
| `DIGEST_DAILY_AT` / `DIGEST_WEEKLY_AT` | `09:00` / `MON 09:00` | `HH:MM` / `MON HH:MM`, `off`로 비활성 |
| `DIGEST_DASHBOARD_UID` | `msa-overview` | 스냅샷·패널 대상 대시보드 |
| `DIGEST_PANEL_IDS` | `8,10` | 첨부할 패널 id(최대 2개) |
| `DIGEST_SNAPSHOT_EXPIRES_SEC` | `604800` | 스냅샷 만료(7일) |
| `DIGEST_TOP_N` / `DIGEST_LOG_TOP_N` | `5` / `5` | 상위 개수 |
| `DIGEST_MIN_REQUESTS` | `50` | 판정에서 제외할 저트래픽 서비스 기준(구간 요청 수) |

## 판정 기준

가장 나쁜 항목으로 정합니다. 기준값은 "초과"일 때 적용됩니다.

| 항목 | 주의 | 위험 | 변수 |
|---|---|---|---|
| 5xx 비율(서비스별·전체, 요청 `DIGEST_MIN_REQUESTS` 이상) | > 1% | > 5% | `DIGEST_5XX_WARN_PCT` / `DIGEST_5XX_CRIT_PCT` |
| p95 지연(서비스별) | > 1s | > 3s | `DIGEST_P95_WARN_SEC` / `DIGEST_P95_CRIT_SEC` |
| Form outbox 최장 대기 | > 300s | > 1800s | `DIGEST_OUTBOX_AGE_WARN_SEC` / `DIGEST_OUTBOX_AGE_CRIT_SEC` |
| Form DB 풀 대기 | >= 1 | - | `DIGEST_POOL_WAITING_WARN` |
| 발화 중 알림 | 있음 | `severity=critical` 있음 | - |
| 인스턴스 | down 있음 | - | - |
| Grafana 규칙 오류 | 있음 | - | - |

Prometheus 수집이 실패했고 다른 위험 신호도 없으면 "판정 불가"로 표시합니다. 이 기본값은 운영 합의 전 제안입니다.

## 개인정보 처리

- 로그는 JSON의 `message`/`msg` 필드(없으면 첫 줄)만 쓰고 원문 전체·요청 본문은 싣지 않습니다.
- 출력 전에 전화번호(하이픈 포함, `+82`), 이메일, UUID, JWT, 32자 이상 토큰 모양, `password/token/secret=` 값을 `***`로 마스킹합니다. 숫자 2자리 이상은 `#`로 접어 묶습니다.
- 배포 주석·알림 이름에도 같은 마스킹을 적용합니다.
- 웹훅 주소와 Grafana 토큰은 로그·오류 메시지·dry-run 출력에 남기지 않습니다(오류는 `HTTP 500`, `연결 실패` 같은 원인 한 줄만). 메시지에는 `allowed_mentions: {parse: []}`를 지정해 로그 내용이 멘션을 일으키지 않게 합니다.
- 스냅샷은 이 Grafana에 저장되는 로컬 스냅샷이며 외부(snapshots.raintank.io)로 올리지 않습니다. 스냅샷 링크를 아는 사람은 로그인 없이 볼 수 있으므로 Discord 채널 접근 범위를 확인하세요.

## 장애 시 동작

- 소스(Prometheus·Grafana 각 호출·Loki)별로 독립 수집합니다. 실패하면 그 구역만 `수집 실패(HTTP 500)`처럼 한 줄로 바뀌고 나머지는 그대로 전송됩니다.
- 스냅샷 실패 시 대시보드 링크로, 패널 이미지 실패 시 이미지 없이 보냅니다.
- Discord 전송은 429(`Retry-After` 초, 최대 30초)와 5xx·네트워크 오류만 최대 2회 재시도하고, 4xx는 즉시 실패합니다. 실패해도 `serve`는 죽지 않고 다음 일정에 다시 시도합니다.
- 임베드 한도(제목 256, 설명 4096, 필드 이름 256/값 1024, 필드 25개, 메시지 합계 6000)를 넘으면 우선순위(요약 > 알림 > 5xx·p95 > 로그 > 인스턴스 > 배포 > 링크)가 낮은 필드부터 다음 메시지로 나누고, 3개 메시지를 넘으면 생략을 표시합니다.

## 전제와 미확인

- 패널 PNG는 Grafana 이미지 렌더러(`GF_RENDERING_SERVER_URL`, `GF_RENDERING_CALLBACK_URL`)가 있어야 합니다. 없으면 이미지 구역만 실패로 표시됩니다.
- Form 지표의 라벨(`form_outbox_records`의 상태 라벨 이름 등)은 Form 서비스 쪽 정의를 확인하지 못했습니다. 라벨이 없거나 달라도 합계로 표시되고, 지표가 없으면 줄이 빠집니다.
- Loki 라벨(`level`)은 로그 수집 설정에 따라 다를 수 있어 `DIGEST_LOKI_QUERY`로 조정합니다.
- 운영 Grafana 버전의 API 차이는 확인하지 못했습니다(검증은 11.3.0).
