// Expo / Overview: every service on one screen (scrape state, RED, runtime) plus cache and index hit
// ratios. Per-service detail lives in the per-service dashboards; this one only compares services.
import {
  RATIO_THRESHOLDS,
  UP_DOWN,
  UP_THRESHOLDS,
  dashboard,
  datasourceVariable,
  row,
  stat,
  table,
  timeseries,
} from './panels.mjs';
import { SERVICES } from './services.mjs';

const avgLatency = [
  'sum by (service) (rate(http_server_requests_seconds_sum[5m]))',
  '/ (sum by (service) (rate(http_server_requests_seconds_count[5m])) > 0)',
  'or',
  'sum by (service) (rate(gateway_http_request_duration_seconds_sum[5m]))',
  '/ (sum by (service) (rate(gateway_http_request_duration_seconds_count[5m])) > 0)',
].join(' ');

export function overview() {
  return dashboard({
    uid: 'expo-overview',
    title: 'Expo / Overview',
    description: '전 서비스의 수집 상태·요청·오류·응답 시간·런타임과 Redis·Postgres 히트율을 한 화면에서 비교합니다.',
    variables: [datasourceVariable('prometheus', { name: 'Prometheus', uid: 'prometheus' })],
    links: SERVICES.map((s) => ({ title: s.label, uid: `expo-svc-${s.short}` })),
    panels: [
      stat('메트릭 수집 상태', [['max by (service) (up{job="eureka-services"})', '{{service}}']], {
        w: 24,
        h: 5,
        description: 'Eureka에 등록된 서비스를 Prometheus가 긁고 있는지(1 = UP). 인스턴스가 여럿이면 하나라도 UP이면 UP입니다.',
        mappings: UP_DOWN,
        thresholds: UP_THRESHOLDS,
        colorMode: 'background',
        textMode: 'value_and_name',
      }),
      timeseries('초당 HTTP 요청 수 (req/s)', [['service:http_requests:rate1m', '{{service}}']], {
        unit: 'reqps',
        description: '서비스별 1분 요청률(recording rule service:http_requests:rate1m).',
      }),
      timeseries('HTTP 5xx 오류 비율 (%)', [['service:http_errors_5xx:ratio1m', '{{service}}']], {
        unit: 'percentunit',
        min: 0,
        max: 1,
        description: '서비스별 1분 5xx 비율. 요청이 없는 서비스는 0입니다.',
      }),
      timeseries('서비스별 HTTP 평균 응답 시간', [[avgLatency, '{{service}}']], {
        unit: 's',
        description: '5분 평균(합계 ÷ 건수). 요청이 없으면 비웁니다. 분위수는 서비스별 대시보드에서 봅니다.',
      }),
      table(
        '현재 활성 알림',
        'ALERTS{alertstate="firing"}',
        { alertname: '알림', severity: '심각도', service: '서비스', instance: '인스턴스' },
        { description: 'Prometheus에서 지금 firing 중인 알림(Alertmanager가 Discord로 보냅니다).' },
      ),
      row('런타임'),
      timeseries('JVM 힙 메모리 사용량', [['sum by (service) (jvm_memory_used_bytes{area="heap"})', '{{service}}']], {
        unit: 'bytes',
        description: 'Spring 서비스의 힙 사용량(모든 힙 영역 합).',
      }),
      timeseries('Node.js 힙 메모리 사용량', [['sum by (service) (nodejs_heap_size_used_bytes)', '{{service}}']], {
        unit: 'bytes',
        description: 'NestJS 서비스의 V8 힙 사용량.',
      }),
      row('캐시·DB'),
      stat('데이터 저장소 수집 상태', [
        ['max by (owner_service, instance) (redis_up)', 'Redis {{instance}}'],
        ['max by (owner_service, instance) (pg_up)', 'Postgres {{instance}}'],
      ], {
        w: 6,
        h: 8,
        description: 'exporter가 저장소에 접속되는지(redis_up, pg_up). 대상은 prometheus/targets/*.yml에 등록합니다.',
        mappings: UP_DOWN,
        thresholds: UP_THRESHOLDS,
        colorMode: 'background',
        textMode: 'value_and_name',
      }),
      stat('Redis 캐시 히트율', [['redis:keyspace_hit_ratio:rate5m', '{{owner_service}} {{instance}}']], {
        w: 6,
        h: 8,
        unit: 'percentunit',
        decimals: 1,
        description: '5분간 키 조회 중 키가 있었던 비율(keyspace_hits ÷ (hits + misses)). 조회가 없으면 값이 없습니다. 색은 참고값입니다.',
        thresholds: RATIO_THRESHOLDS,
        colorMode: 'background',
        textMode: 'value_and_name',
      }),
      timeseries('Redis 캐시 히트율 추이', [['redis:keyspace_hit_ratio:rate5m', '{{owner_service}} {{instance}}']], {
        unit: 'percentunit',
        min: 0,
        max: 1,
      }),
      timeseries('Postgres 버퍼 캐시 히트율', [['pg:buffer_cache_hit_ratio:rate5m', '{{owner_service}} {{datname}}']], {
        unit: 'percentunit',
        max: 1,
        description: '필요한 블록 중 디스크를 읽지 않고 shared buffers에서 찾은 비율(blks_hit ÷ (hit + read)).',
      }),
      timeseries('Postgres 인덱스 스캔 비율', [['pg:index_scan_ratio:rate5m', '{{owner_service}} {{datname}}']], {
        unit: 'percentunit',
        max: 1,
        description: '사용자 테이블 스캔 중 인덱스 스캔의 비율(idx_scan ÷ (idx_scan + seq_scan)). 바쁜 DB에서 낮으면 인덱스가 빠졌을 수 있습니다. 작은 테이블은 일부러 순차 스캔합니다.',
      }),
      timeseries('Postgres 인덱스 블록 히트율', [['pg:index_block_hit_ratio:rate5m', '{{owner_service}} {{datname}}']], {
        unit: 'percentunit',
        max: 1,
        description: '인덱스 블록 중 shared buffers에서 찾은 비율(idx_blocks_hit ÷ (hit + read)).',
      }),
      table(
        '순차 스캔으로 읽은 행이 많은 테이블 (5분)',
        'topk(10, sum by (owner_service, datname, relname) (rate(pg_stat_user_tables_seq_tup_read[5m])) > 0)',
        { owner_service: '서비스', datname: 'DB', relname: '테이블', Value: '초당 읽은 행' },
        { description: '순차 스캔으로 읽은 행 수 상위 10개 테이블. 인덱스 후보를 찾을 때 봅니다.', unit: 'short' },
      ),
      timeseries('Redis 메모리 사용량', [['max by (owner_service, instance) (redis_memory_used_bytes)', '{{owner_service}} {{instance}}']], {
        unit: 'bytes',
      }),
      timeseries('Redis 초당 축출 키 수', [['sum by (owner_service, instance) (rate(redis_evicted_keys_total[5m]))', '{{owner_service}} {{instance}}']], {
        unit: 'short',
        description: 'maxmemory에 닿아 지워진 키. 0이 아니면 캐시가 메모리에 비해 큽니다.',
      }),
    ],
  });
}
