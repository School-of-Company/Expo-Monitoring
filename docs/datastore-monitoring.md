# 캐시·DB 히트율 (Redis, Postgres)

서비스 앱에는 캐시 히트율 지표가 없습니다(`@Cacheable` 같은 앱 캐시를 쓰지 않습니다). 그래서 히트율은 저장소 서버 쪽 지표로 봅니다. Redis는 [redis_exporter](https://github.com/oliver006/redis_exporter), Postgres는 [postgres_exporter](https://github.com/prometheus-community/postgres_exporter)가 냅니다.

## 수집 대상 등록

Redis·Postgres는 Eureka에 없으므로 대상 파일로 등록합니다. Prometheus는 파일을 다시 읽으므로 설정 변경·재시작 없이 반영됩니다.

| job | 대상 파일 | exporter |
|---|---|---|
| `redis` | `prometheus/targets/redis.yml` | Redis 인스턴스마다 하나 (`REDIS_ADDR`) |
| `postgres` | `prometheus/targets/postgres.yml` | DB 서버마다 하나 (`DATA_SOURCE_NAME`) |

```yaml
# prometheus/targets/postgres.yml
- targets: ["127.0.0.1:9187"]
  labels:
    service: expo-form-server   # 이 DB를 쓰는 서비스(Eureka 앱 이름 소문자). 대시보드가 이 값으로 묶습니다.
    instance: form-db
```

- `service`는 반드시 넣습니다. 여러 서비스가 함께 쓰는 Redis라면 대표 서비스 이름이나 `shared`를 씁니다.
- 기본 파일은 빈 목록(`[]`)이라 대상이 없으면 패널은 "No data"입니다.
- exporter의 DB 계정은 읽기 전용으로 둡니다. postgres_exporter는 `pg_monitor` 역할이면 충분합니다. 접속 정보는 이 저장소에 두지 않습니다.

## recording rule (`prometheus/rules/datastore.yml`)

모든 비율은 5분 창이며 **트래픽이 있을 때만** 값이 있습니다. 쉬는 저장소는 0%도 100%도 아닌 "값 없음"입니다.

| 이름 | 식 | 뜻 |
|---|---|---|
| `redis:keyspace_hit_ratio:rate5m` | `keyspace_hits ÷ (hits + misses)` | 키 조회 중 키가 있었던 비율 |
| `pg:buffer_cache_hit_ratio:rate5m` | `blks_hit ÷ (blks_hit + blks_read)` (template DB 제외) | 디스크 대신 shared buffers에서 찾은 블록 비율 |
| `pg:index_scan_ratio:rate5m` | `idx_scan ÷ (idx_scan + seq_scan)` (사용자 테이블 합) | 스캔 중 인덱스 스캔 비율 |
| `pg:index_block_hit_ratio:rate5m` | `idx_blocks_hit ÷ (hit + read)` | 인덱스 블록 중 shared buffers에서 찾은 비율 |

라벨은 `service`, `instance`(Postgres는 `datname` 추가)입니다. `prometheus/tests/datastore.test.yml`이 비율 값, 쉬는 저장소, template DB 제외를 검사합니다.

## 대시보드

**Expo / Overview**(`expo-overview`)의 "캐시·DB" 구역에 있습니다: 저장소 수집 상태(`redis_up`, `pg_up`), Redis 히트율(현재 값과 추이), Postgres 버퍼 캐시·인덱스 스캔·인덱스 블록 히트율, 순차 스캔으로 읽은 행이 많은 테이블 상위 10개, Redis 메모리·축출 키.

- 색(빨강 80% 미만, 노랑 95% 미만, 초록)은 참고값이며 합의된 목표가 아닙니다. 알림은 두지 않았습니다.
- 인덱스 스캔 비율이 낮아도 작은 테이블은 일부러 순차 스캔하므로, "순차 스캔으로 읽은 행이 많은 테이블"에서 실제로 많이 읽는 테이블을 먼저 봅니다.

## 운영 배포 (미검증)

서버는 Docker 없이 바이너리/pm2로 실행합니다. 서버의 `deploy.sh`(이 저장소 밖)가 다음을 해야 하며, 이 저장소에서는 확인하지 못했습니다.

- redis_exporter v1.67.0, postgres_exporter v0.17.1 바이너리 실행(Redis·DB마다 하나, loopback listener)
- `prometheus/targets/*.yml`에 실제 exporter 주소와 `service` 라벨 기입, 경로 `/etc/prometheus/targets`를 서버 경로로 치환
- 실제 Redis·DB 위치와 계정은 서버에서 확인합니다.

## 로컬 데모

`docker-compose.demo.yml`이 Redis·Postgres와 두 exporter, 일정한 부하(`dev/datastore/`: Redis 조회 90% 히트, Postgres 인덱스 조회 3회와 순차 스캔 1회)를 띄우고, Prometheus는 `dev/targets/`를 대상 파일로 씁니다. `dev/verify-demo.mjs`가 대상의 `service` 라벨과 네 비율의 값 범위, Overview 패널의 데이터를 검사합니다.
