# Expo-Monitoring

Expo MSA 공용 모니터링 스택(Prometheus + Grafana). scrape 대상은 **Eureka 서비스 디스커버리**로 자동 수집하므로 서비스나 인스턴스가 늘어도 Prometheus 설정을 고치지 않습니다.

## 실행

```bash
cp .env.example .env        # EUREKA_HOST, GRAFANA_ADMIN_PASSWORD 설정
docker compose up -d        # Grafana http://127.0.0.1:3001, Prometheus http://127.0.0.1:9090
docker compose down         # -v 금지 (대시보드·시계열 볼륨 보존)
```

- Prometheus는 `http://eureka:8761/eureka`를 조회합니다. `eureka` 이름은 `EUREKA_HOST`(미설정 시 Docker 호스트)로 연결됩니다.
- Prometheus·Grafana는 `127.0.0.1`에만 publish합니다. 서버에서는 SSH 포워딩으로 접속하세요.
- 데모(실제 서비스 없이 확인): `EUREKA_HOST=172.28.0.50 docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d`

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

Alertmanager는 아직 없어서 Prometheus UI의 Alerts 탭에서만 확인합니다.

- `ServiceDown`: Eureka에 있는데 scrape가 1분간 실패. 크래시한 인스턴스를 Eureka가 evict하면 target이 사라져 알림도 해소되므로, 장애 기록으로 쓰지 마세요.
- `ServiceHigh5xxRate`: 서비스별 5xx > 5% (5분), 요청률 0.1 req/s 미만이면 제외
- Gateway 전용: `GatewayUpstream502Rate`, `GatewayNoHealthyInstances`, `GatewayEurekaPollFailing`. Expo-Gateway에서 가져왔고, `GatewayDown`·`GatewayHigh5xxRate`는 공통 룰이 대신합니다.

## 대시보드

- **MSA Service Overview**: `$service` 변수로 전환하는 RED + 인스턴스 + 런타임(JVM/Node)
- **Expo Gateway**: Gateway 전용 (Expo-Gateway의 `monitoring/grafana/dashboards/gateway.json` 사본. 원본을 고치면 여기도 갱신하세요)

## 검증

```bash
docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" prom/prometheus:v2.55.1 check config /p/prometheus.yml
docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" prom/prometheus:v2.55.1 check rules /p/rules/recording.yml /p/rules/alerts.yml
docker run --rm --entrypoint promtool -v "$PWD/prometheus:/p:ro" prom/prometheus:v2.55.1 test rules /p/tests/rules.test.yml
```

## 한계

- 실제 Eureka 서버 이미지(`steeltoeoss/eurekaserver`, Spring Cloud Netflix)에 metadata를 단 인스턴스를 등록해 디스커버리와 룰 로딩을 확인했습니다. 실제 MSA 서비스들은 아직 metadata를 등록하지 않아서 자동 수집은 그 이후에 됩니다.
- 로컬 데모는 가짜 Eureka(XML)와 가짜 서비스를 씁니다.
- 대시보드 JSON은 파일 프로비저닝이라 UI에서 수정해도 저장되지 않습니다.
