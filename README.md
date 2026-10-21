# Expo-Monitoring

Expo MSA 공용 모니터링 스택(Prometheus + Grafana + Loki + Tempo). scrape 대상은 **Eureka 서비스 디스커버리**로 자동 수집하므로 서비스나 인스턴스가 늘어도 Prometheus 설정을 고치지 않습니다.

## 실행

```bash
cp .env.example .env        # EUREKA_HOST, GRAFANA_ADMIN_PASSWORD 설정
docker compose up -d        # Grafana http://127.0.0.1:3001, Prometheus http://127.0.0.1:9090
docker compose down         # -v 금지 (대시보드·시계열 볼륨 보존)
```

- Prometheus는 `http://eureka:8761/eureka`를 조회합니다. `eureka` 이름은 `EUREKA_HOST`(미설정 시 Docker 호스트)로 연결됩니다.
- Prometheus·Grafana는 `127.0.0.1`에만 publish합니다. 서버에서는 SSH 포워딩으로 접속하세요.
- 데모(실제 서비스 없이 확인, `!reset`을 지원하는 Docker Compose 필요): `docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d`
- 데모는 네트워크 별칭 `eureka`와 컨테이너의 실제 IP를 사용합니다. 고정 서브넷·IP와 `EUREKA_HOST` 설정은 필요하지 않습니다.
- 로그(Loki·Alloy)와 추적(Tempo, OTLP는 `127.0.0.1:4317/4318`)은 [로그와 추적](docs/logs-and-tracing.md), Discord 알림·그래프 이미지는 [Grafana 알림](docs/alerting.md)(런북: [docs/runbooks.md](docs/runbooks.md))을 참고하세요.
- 새 서버의 환경 변수와 배포 점검은 [배포 환경 안내](docs/deployment-environment.md)를 참고하세요.

기존 고정 서브넷(172.28.0.0/24)으로 Compose를 실행한 호스트는 업데이트 후 기존 네트워크를 먼저 제거하고 다시 시작합니다. 아래 `down`은 데이터 볼륨을 보존합니다. `-v`를 추가하지 마세요. 데모를 실행 중이었다면 두 명령 모두 `-f docker-compose.yml -f docker-compose.demo.yml`을 함께 사용합니다.

```bash
docker compose down
docker compose up -d
```

## 서비스가 수집되려면 (Eureka metadata)

| 키 | 예시 | 의미 |
|---|---|---|
| `prometheus.scrape` | `"true"` | 이 인스턴스를 수집 (없거나 `true`가 아니면 제외) |
| `prometheus.port` | `"9464"` | 메트릭 포트. 서비스 포트와 분리. 없으면 제외 |
| `prometheus.path` | `"/actuator/prometheus"` | 메트릭 경로. 없으면 `/metrics` |

수집된 시계열에는 `service`(소문자 Eureka 앱 이름)와 `instance`(Eureka instanceId) 라벨이 붙습니다.

## 공통 메트릭 규약

Spring(Micrometer)과 NestJS 모두 `http_server_requests_seconds{method,status,uri}`를 노출합니다(`uri`는 라우트 템플릿만, 원본 경로·사용자 ID·토큰 금지). 지연 분위수에는 히스토그램이 필요합니다. Spring은 `management.metrics.distribution.percentiles-histogram.http.server.requests=true`를 켜세요. Gateway는 `gateway_http_*`를 유지하고 recording rule에서 같은 이름으로 맞춥니다.

| recording rule | 의미 |
|---|---|
| `service:http_requests:rate1m` | 서비스별 요청률 |
| `service:http_errors_5xx:ratio1m` | 서비스별 5xx 비율 |
| `service:http_latency_p95:5m` | 서비스별 p95 지연 |

## 알림 (`prometheus/rules/alerts.yml`)

Alertmanager는 아직 없어서 이 규칙은 Prometheus UI의 Alerts 탭에서만 확인합니다. Discord로 가는 Grafana 관리 알림(그래프 이미지 첨부)은 [별도](docs/alerting.md)입니다.

- `ServiceDown`: Eureka에 있는데 scrape가 1분간 실패. 크래시한 인스턴스를 Eureka가 evict하면 target이 사라져 알림도 해소되므로, 장애 기록으로 쓰지 마세요.
- `ServiceHigh5xxRate`: 서비스별 5xx > 5% (5분), 요청률 0.1 req/s 미만이면 제외
- Gateway 전용: `GatewayUpstream502Rate`, `GatewayNoHealthyInstances`, `GatewayEurekaPollFailing`. Expo-Gateway에서 가져왔고, `GatewayDown`·`GatewayHigh5xxRate`는 공통 룰이 대신합니다.
- Attendance 전용: 회로 열림, 입구 5xx/p95, downstream failure, guard lock p95, QR pending. [계약·초기 임계값 근거·운영 미확인](docs/attendance-monitoring.md)을 참고하세요. 임계값은 운영 합의 전 제안입니다.

## 대시보드

- **MSA Service Overview**: `$service` 변수로 전환하는 RED + 인스턴스 + 런타임(JVM/Node)
- **Expo Gateway**: Gateway 전용 (Expo-Gateway 원본에서 가져왔으며, 공유 스택의 런타임 쿼리에는 `service="expo-gateway"` 필터를 추가했습니다. 원본 갱신 시 이 필터를 유지하세요)
- **Expo Form**: 아웃박스 가장 오래된 미발행 건의 나이, DB 연결 풀(Grafana 알림의 패널 이미지용)
- **Expo Attendance**: 입구 스캔 RED, name별 회로, 대상/outcome별 호출, kind별 락 대기, QR backlog. 실제 Eureka 이름은 `expo-attention-server`입니다.

## 검증

```bash
bash dev/validate-prometheus.sh
```

설정 검사에는 `/etc/prometheus/rules` 마운트가 필요합니다. 빠지면 설정의 절대 경로 glob이 룰 파일을 찾지 못해도 검사가 통과할 수 있습니다.

데모를 실행한 뒤 실제 Prometheus의 자동 대상 추가·삭제, opt-in 제외, 공통 RED와 Grafana의 대시보드 쿼리, Loki 로그 수집·마스킹, Tempo의 OTLP 조회, 알림 프로비저닝과 가짜 웹훅의 이미지 첨부, 스냅샷 설정을 검사합니다(알림 발화를 기다려 약 4분 걸립니다). 기존 Grafana 볼륨을 사용한다면 `GRAFANA_ADMIN_PASSWORD`는 현재 관리자 비밀번호와 같아야 합니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml exec -T -e GRAFANA_ADMIN_PASSWORD fake-services node /app/verify-demo.mjs
docker compose -f docker-compose.yml -f docker-compose.demo.yml down
```

`Validate monitoring` CI는 PR과 `develop` push에서 같은 검사를 실행합니다. 유휴 카운터와 5xx 시계열이 없는 서비스의 오류 비율은 0으로 기록하고, 전체 요청 시계열이 없는 서비스는 생성하지 않습니다. 룰 테스트는 저트래픽 알림 억제와 공통·Gateway 전용 알림도 검사합니다.

## 한계

- 실제 서비스 수집 여부는 배포된 Eureka metadata와 메트릭 listener에 달려 있습니다. Gateway metadata 변경과 Config Server 규약 이슈는 병합/완료되었지만, 현재 운영 targets와 서비스별 적용·배포 완료를 이 저장소의 로컬 검증으로 판단하지 않습니다.
- 로컬 데모는 가짜 Eureka(XML)와 가짜 서비스를 씁니다.
- 대시보드 JSON은 파일 프로비저닝이라 UI에서 수정해도 저장되지 않습니다.
