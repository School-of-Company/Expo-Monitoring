# Deployment environment

새 서버는 `/srv/users/projects/2026/team1/expo`의 단일 환경입니다. 저장소의 Docker Compose 실행과 서버의 바이너리/pm2 배포를 구분해서 설정해야 합니다. 아래는 값 대신 변수명과 확인 방법을 기록합니다.

## Docker Compose

| 변수 | 미설정 시 | 용도와 주의 |
|---|---|---|
| `GRAFANA_ADMIN_PASSWORD` | `admin` | Grafana 초기 관리자 비밀번호. `.env.example`의 `change-me`와 기본값을 실제 환경에서 사용하지 않습니다. 기존 Grafana 데이터가 있으면 이 변수 변경만으로 관리자 비밀번호가 교체되지 않습니다. |
| `EUREKA_HOST` | `host-gateway` | `eureka` 이름에 매핑할 주소. Eureka가 Docker 호스트에서 실행되면 비워 두고, 다른 호스트라면 그 주소를 설정합니다. 포트는 변경하지 않습니다. |
| `DISCORD_WEBHOOK_URL` | Grafana: 연결 불가 자리표시 주소 / Alertmanager: 빈 값 | Grafana 연락처와 Alertmanager(compose secret 파일)의 웹훅. 비밀이므로 서버 `.env`에만 둡니다. [알림 문서](alerting.md) |
| `GRAFANA_ROOT_URL` | `http://127.0.0.1:3001` | 알림 메시지의 대시보드·패널·silence 링크 기준 주소 |
| `LOG_DIR` | `./logs`(빈 디렉터리) | Alloy가 읽기 전용으로 마운트할 로그 디렉터리. 운영은 PM2 로그 디렉터리, 로컬은 서비스의 `EXPO_LOG_DIR`(기본 `~/.expo/logs`). `*.log`를 하위 경로까지 수집. 실제 경로는 서버에서 확인. [로그 표준](logging.md) |
| `LOKI_RETENTION_PERIOD` | `168h` | 로그 보존 기간 |
| `TEMPO_RETENTION_PERIOD` | `168h` | 추적 보존 기간 |

`.env`는 커밋하지 않습니다. Compose의 Prometheus/Grafana/Alertmanager 공개 포트는 각각 `127.0.0.1:9090`, `127.0.0.1:3001`, `127.0.0.1:9093`이고 SSH 터널로 접근합니다. Tempo의 OTLP(`127.0.0.1:4317`, `4318`)도 loopback에만 publish하며, Loki·Alloy·이미지 렌더러는 publish하지 않습니다. 데모에서는 `EUREKA_HOST` 매핑을 제거하고 가짜 서비스의 네트워크 별칭으로 Eureka를 찾습니다.

## New server: binaries and pm2

GitHub 워크플로는 `prometheus/`, `grafana/`, `loki/`, `alloy/`를 묶어서 업로드합니다. 서버의 `deploy.sh`가 Loki·Alloy를 실행하고 경로·주소를 치환해야 하며([로그 표준](logging.md#운영-배포-미검증)), `tempo/`와 Tempo·렌더러 서비스는 아직 이 배포 경로에 포함되어 있지 않아 서버에서 바이너리/pm2로 어떻게 띄울지 정해야 합니다(미확정, 서버의 Docker 사용 가능 여부도 미확인). `.env`와 `docker-compose.yml`을 전송하거나 실행하지 않으므로 Compose의 `GRAFANA_ADMIN_PASSWORD`, `EUREKA_HOST`가 서버 프로세스에 자동 적용되지 않습니다.

- Grafana는 서버에서 `GF_SECURITY_ADMIN_PASSWORD` 또는 Grafana 설정 파일의 `[security] admin_password`를 설정해야 합니다. 서버의 실제 설정 방식과 기존 관리자 비밀번호는 별도 확인이 필요합니다. 기존 DB의 비밀번호 변경은 Grafana 관리자 절차를 사용합니다.
- Prometheus 설정의 Eureka 주소는 기본 `http://eureka:8761/eureka`입니다. 서버 배포 스크립트가 실제 주소로 변환하는지, 실제 포트·경로가 맞는지 배포 결과 파일에서 확인합니다. Compose 이름 해석을 바이너리 실행에 그대로 적용하지 않습니다.
- 서버 배포 스크립트가 룰 경로 `/etc/prometheus/rules`, Grafana datasource `http://prometheus:9090`, 대시보드 경로 `/var/lib/grafana/dashboards`를 실제 서버 경로·주소로 변환하는지도 확인합니다.
- Grafana·Prometheus의 HTTP listener를 loopback에 두고, 데이터 디렉터리와 관리자 설정을 릴리스 교체·롤백 시 보존합니다. 실제 listener/데이터 경로/방화벽은 저장소에서 확정할 수 없습니다.

## GitHub deployment settings

| 구분 | 이름 | 용도 |
|---|---|---|
| Repository variable | `EXPO_SSH_HOST` | SSH 호스트 |
| Repository variable | `EXPO_SSH_PORT` | SSH 포트 |
| Repository variable | `EXPO_SSH_USER` | SSH 사용자 |
| Repository secret | `EXPO_SSH_KEY` | SSH 개인키 |
| Repository secret | `EXPO_SSH_KNOWN_HOSTS` | 검증된 서버 공개키 목록 |

`main` push 또는 `main`의 수동 workflow dispatch만 배포합니다. `develop` push는 검증 CI만 실행합니다. `main` 이외 브랜치에서 `Deploy`를 수동 실행하면 배포 job을 건너뜁니다. 업로드 위치는 `app/monitoring/incoming/<release>.tar.gz`이고 서버의 `bin/deploy.sh monitoring prod <release>`를 호출합니다. `prod`는 단일 환경 스크립트의 인자 호환용입니다.

운영 점검은 서버의 제한된 조회 권한으로 수행해야 합니다. 기능 브랜치의 스크립트를 운영 배포 SSH 키로 실행하는 job은 제공하지 않습니다. 과거 점검 실행 결과는 아래 기록으로 남깁니다.

## Metrics collection and release checks

Eureka 인스턴스에 `prometheus.scrape="true"`, 숫자 `prometheus.port`, 필요하면 `prometheus.path`가 있어야 합니다. 경로가 없으면 `/metrics`이며 Spring은 `/actuator/prometheus`를 등록합니다. Gateway는 자기 메트릭 이름을 공통 RED 룰에서 변환합니다. Config Server #8의 공통 규약 완료는 모든 서비스의 운영 적용을 뜻하지 않습니다.

- 메트릭 listener는 Prometheus에서 접근 가능한 내부 주소에 바인딩합니다. 같은 호스트의 바이너리라면 loopback이 가능하지만, 다른 컨테이너/호스트에서 수집할 때 서비스의 loopback만으로는 접근할 수 없습니다.
- 메트릭 포트를 공용 인터넷에 공개하지 말고 Prometheus의 실제 출발지에서만 허용합니다. 서비스 등록 시 광고된 IP와 메트릭 포트가 그 경로로 접근 가능한지 확인합니다.
- Eureka와 대상 서비스를 기동한 뒤 Prometheus `/api/v1/targets`에서 Gateway 포함 대상, `health=up`, 마지막 scrape 오류, 제외된 metadata를 확인합니다. 인스턴스 추가·삭제가 새로고침 없이 반영되는지도 확인합니다.
- Prometheus `/-/ready`, `/api/v1/rules`, Grafana `/api/health`와 세 대시보드의 datasource 쿼리를 확인합니다. Alertmanager는 Compose(개발·검증용)에만 있고 **운영 서버 배포 방식은 미정**입니다([알림 문서](alerting.md)의 "운영 배포"). `deploy.yml`은 아직 `alertmanager/`를 올리지 않습니다.
- 운영 확인 기록에는 시각, 배포 SHA, 대상 서비스·인스턴스, scrape 결과, 내부 접근 경로와 방화벽 조건만 남깁니다. 토큰·비밀번호·SSH 키는 기록하지 않습니다.

## Verification status (2026-10-12)

Attendance #8의 추가 로컬 검증 및 이번 작업에서 미확인인 운영 항목은 [Attendance 안내](attendance-monitoring.md)에 기록합니다. 아래는 #7 시점의 과거 기록입니다.

GitHub 배포 변수 3개와 Secret 2개의 등록 여부를 확인했습니다. Secret 값과 실제 서버 적용 여부는 읽거나 검증하지 않았습니다.

로컬 Prometheus v2.55.1과 Grafana 11.3.0 데모에서 정상 대상 4개, 제외 대상 3개, 인스턴스 제거·추가 자동 반영, 공통 RED 기록, 룰 8개 로드, 두 대시보드의 37개 쿼리를 확인했습니다. Gateway 런타임 쿼리는 다른 서비스의 런타임 지표가 함께 있어도 Gateway 시계열만 반환했습니다. 실제 컨테이너의 Prometheus/Grafana 공개 바인딩은 loopback이고 가짜 서비스의 메트릭 포트는 공개하지 않습니다. 이 결과는 운영 서버 검증을 대체하지 않습니다.

로컬 SSH는 호스트키 검증 실패로 접속하지 못했지만, GitHub Actions에 등록된 SSH 키·known hosts를 사용한 [읽기 전용 운영 점검](https://github.com/School-of-Company/Expo-Monitoring/actions/runs/38192399967)이 성공했습니다. 호스트키 검증을 우회하거나 서버를 배포하지 않았습니다.

2026-10-12 01:34 UTC 기준 Prometheus는 `127.0.0.1:26114`, Grafana는 `127.0.0.1:26115`에서 실행 중입니다. Grafana DB health는 `ok`입니다. Prometheus targets API에 Gateway, Attention, Report, Expo, User, Application 6개 서비스가 있고 모두 `up`입니다. Gateway 메트릭은 `127.0.0.1:26113`, 나머지 수집 대상은 `127.0.0.1:26123`~`26127`의 해당 서비스 포트를 사용합니다. 이 포트들의 실제 listener는 모두 IPv4 또는 IPv4-mapped IPv6 loopback입니다.

수집은 같은 호스트의 loopback에서 이루어지므로 컨테이너 간 방화벽 허용에 의존하지 않으며, 확인한 UI·메트릭 listener는 공용 네트워크 인터페이스에 바인딩하지 않습니다. OS 방화벽 규칙 전체를 조회하거나 외부 네트워크 침투 검사를 수행하지는 않았습니다. 서버가 단일 환경이므로 이번 검증은 이 운영 환경을 대상으로 하며 별도 스테이징 검증 결과는 없습니다.

Form·Notification 등은 이 확인 시점의 수집 대상 6개 목록에 없습니다. 서비스별 metadata와 listener 적용·배포 여부는 해당 서비스 담당 범위에서 확인해야 합니다. 운영 관리자 비밀번호, 데이터 보존·롤백과 현재 배포 SHA는 확인하지 않았습니다. PR의 룰·대시보드 수정은 아직 운영에 배포하지 않았습니다.
