// One dashboard per scraped service (Expo / <서비스>): scrape state and runtime at a glance on top,
// then HTTP and runtime detail. Domain panels stay in the hand-written dashboards linked at the top
// (Attendance, Form, Gateway). Config Server exposes no metrics and is not in Eureka, so it has none.
//
// Metric names follow what the services actually expose: Spring Boot 4.1 Micrometer (jvm_gc_overhead,
// jvm_gc_pause_seconds with a decaying max, registered at the first GC — buckets only where the service sets
// management.metrics.distribution.slo.jvm.gc.pause;
// lettuce_seconds{db_operation}) and Node prom-client 15 defaults.
import {
  UP_DOWN,
  UP_THRESHOLDS,
  dashboard,
  datasourceVariable,
  gauge,
  row,
  stat,
  table,
  timeseries,
} from './panels.mjs';

export const SERVICES = [
  { name: 'expo-attention-server', label: '참여', short: 'attention', runtime: 'jvm', domain: { title: 'Expo Attendance (입구 스캔)', uid: 'expo-attendance' } },
  { name: 'expo-user-server', label: '유저', short: 'user', runtime: 'jvm', redis: true },
  { name: 'expo-expo-server', label: '박람회', short: 'expo', runtime: 'jvm', redis: true },
  { name: 'expo-report-server', label: '리포트', short: 'report', runtime: 'jvm' },
  { name: 'expo-application-server', label: '신청', short: 'application', runtime: 'jvm', redis: true },
  { name: 'expo-gateway', label: '게이트웨이', short: 'gateway', runtime: 'node', gateway: true, domain: { title: 'Expo Gateway (라우팅·업스트림)', uid: 'expo-gateway' } },
  { name: 'expo-form-server', label: '폼', short: 'form', runtime: 'node', domain: { title: 'Expo Form (아웃박스·공개 설문)', uid: 'expo-form' } },
  { name: 'expo-notification-server', label: '알림', short: 'notification', runtime: 'node' },
];

function http(s) {
  const sel = `service="${s.name}"`;
  // The gateway keeps its own gateway_http_* names (see prometheus/rules/recording.yml).
  const count = s.gateway ? `gateway_http_requests_total{${sel}}` : `http_server_requests_seconds_count{${sel}}`;
  const bucket = s.gateway ? `gateway_http_request_duration_seconds_bucket{${sel}}` : `http_server_requests_seconds_bucket{${sel}}`;
  const quantile = (q) => `histogram_quantile(${q}, sum by (le) (rate(${bucket}[5m])))`;
  return [
    row('HTTP'),
    timeseries('초당 요청 수 (상태 코드별)', [[`sum by (status) (rate(${count}[1m]))`, '{{status}}']], { unit: 'reqps' }),
    timeseries('HTTP 5xx 오류 비율 (%)', [[`service:http_errors_5xx:ratio1m{${sel}}`, '5xx']], { unit: 'percentunit', min: 0, max: 1 }),
    timeseries('응답 시간 분위수', [[quantile(0.5), 'p50'], [quantile(0.95), 'p95'], [quantile(0.99), 'p99']], {
      unit: 's',
      description: '5분 창 히스토그램 분위수(버킷 경계 사이는 보간한 값입니다).',
    }),
    s.gateway
      ? table('라우트별 요청 수 (5분)', `topk(10, sum by (app) (rate(${count}[5m])) > 0)`, { app: '라우트(app)', Value: '초당 요청' }, { unit: 'reqps' })
      : table('경로별 요청 수 상위 10 (5분)', `topk(10, sum by (method, uri) (rate(${count}[5m])) > 0)`, { method: '메서드', uri: '경로', Value: '초당 요청' }, { unit: 'reqps' }),
  ];
}

function jvm(s) {
  const sel = `service="${s.name}"`;
  const panels = [
    row('런타임 (JVM)'),
    timeseries('힙 메모리', [
      [`sum by (instance) (jvm_memory_used_bytes{area="heap",${sel}})`, '사용 {{instance}}'],
      [`sum by (instance) (jvm_memory_committed_bytes{area="heap",${sel}})`, '확보 {{instance}}'],
      [`sum by (instance) (jvm_memory_max_bytes{area="heap",${sel}} > 0)`, '한도 {{instance}}'],
    ], { unit: 'bytes', description: '한도는 한도가 있는 영역(G1 Old Gen 등)의 합입니다. G1의 young 영역은 -1(한도 없음)로 보고되어 뺍니다.' }),
    timeseries('GC 정지 시간 최대 (수집기별)', [[`max by (gc) (jvm_gc_pause_seconds_max{${sel}})`, '{{gc}}']], {
      unit: 's',
      min: 0,
      description: '최근 약 2분 동안 GC 한 번이 멈춘 가장 긴 시간(Micrometer의 감쇠 최댓값). 요청 지연이 튀는 시점과 겹치는지 봅니다. 서비스가 기동 후 GC를 한 번도 하지 않았으면 비어 있습니다.',
    }),
    timeseries('GC 정지 시간 p99 (수집기별)', [[`histogram_quantile(0.99, sum by (le, gc) (rate(jvm_gc_pause_seconds_bucket{${sel}}[5m])))`, '{{gc}}']], {
      unit: 's',
      min: 0,
      description: 'GC 한 번이 멈춘 시간의 99번째 백분위(5분 창). 서비스가 management.metrics.distribution.slo.jvm.gc.pause(1ms~2s 버킷)를 설정해야 값이 나옵니다. 버킷 사이는 보간한 근사값입니다.',
    }),
    timeseries('GC 평균 정지 시간 (수집기별)', [[
      `sum by (gc) (rate(jvm_gc_pause_seconds_sum{${sel}}[5m])) / (sum by (gc) (rate(jvm_gc_pause_seconds_count{${sel}}[5m])) > 0)`,
      '{{gc}}',
    ]], { unit: 's', min: 0, description: 'GC 한 번당 평균 정지 시간(5분 창). 분위수(p99)는 서비스가 히스토그램 버킷을 내야 볼 수 있습니다.' }),
    timeseries('GC 오버헤드 (%)', [[`max by (instance) (jvm_gc_overhead{${sel}})`, '{{instance}}']], {
      unit: 'percentunit',
      min: 0,
      description: '최근 구간 CPU 시간 중 GC에 쓴 비율(jvm_gc_overhead).',
    }),
    timeseries('초당 힙 할당량', [[`sum by (instance) (rate(jvm_gc_memory_allocated_bytes_total{${sel}}[1m]))`, '{{instance}}']], { unit: 'Bps' }),
    timeseries('프로세스 CPU 사용률', [[`max by (instance) (process_cpu_usage{${sel}})`, '{{instance}}']], { unit: 'percentunit', min: 0 }),
    timeseries('스레드', [
      [`sum by (instance) (jvm_threads_live_threads{${sel}})`, '살아 있음 {{instance}}'],
      [`sum by (instance) (jvm_threads_daemon_threads{${sel}})`, '데몬 {{instance}}'],
      [`sum by (instance) (jvm_threads_peak_threads{${sel}})`, '최대 {{instance}}'],
    ]),
    timeseries('DB 커넥션 풀 (Hikari)', [
      [`sum by (instance) (hikaricp_connections_active{${sel}})`, '사용 중 {{instance}}'],
      [`sum by (instance) (hikaricp_connections_idle{${sel}})`, '유휴 {{instance}}'],
      [`sum by (instance) (hikaricp_connections_pending{${sel}})`, '대기 {{instance}}'],
      [`sum by (instance) (hikaricp_connections_max{${sel}})`, '최대 {{instance}}'],
    ], { description: '대기(pending)가 0보다 크면 풀이 모자랍니다.' }),
  ];
  if (s.redis) {
    panels.push(
      timeseries('Redis 명령 수 (초당)', [[`sum by (db_operation) (rate(lettuce_seconds_count{${sel}}[1m]))`, '{{db_operation}}']], { unit: 'ops' }),
      timeseries('Redis 명령 평균 지연', [[
        `sum by (db_operation) (rate(lettuce_seconds_sum{${sel}}[5m])) / (sum by (db_operation) (rate(lettuce_seconds_count{${sel}}[5m])) > 0)`,
        '{{db_operation}}',
      ]], { unit: 's', description: '앱(Lettuce)에서 잰 명령 왕복 시간. 캐시 히트율은 Overview의 캐시·DB 구역에서 봅니다.' }),
    );
  }
  return panels;
}

function node(s) {
  const sel = `service="${s.name}"`;
  const gcBucket = `nodejs_gc_duration_seconds_bucket{${sel}}`;
  return [
    row('런타임 (Node.js)'),
    timeseries('이벤트 루프 지연 (가장 느린 인스턴스)', [
      [`max(nodejs_eventloop_lag_p50_seconds{${sel}})`, 'p50'],
      [`max(nodejs_eventloop_lag_p90_seconds{${sel}})`, 'p90'],
      [`max(nodejs_eventloop_lag_p99_seconds{${sel}})`, 'p99'],
      [`max(nodejs_eventloop_lag_max_seconds{${sel}})`, '최대'],
    ], {
      unit: 's',
      min: 0,
      description: '이벤트 루프가 밀린 시간. p99가 50ms를 넘으면 동기 작업이나 GC가 요청 처리를 막고 있다는 신호입니다. 인스턴스 중 가장 큰 값을 보여 줍니다.',
    }),
    timeseries('GC 정지 시간 p99 (종류별)', [[`histogram_quantile(0.99, sum by (le, kind) (rate(${gcBucket}[5m])))`, '{{kind}}']], {
      unit: 's',
      min: 0,
      description: 'GC 한 번이 멈춘 시간의 99번째 백분위(5분 창). prom-client의 버킷(1ms, 10ms, 100ms, 1s, 2s, 5s) 사이는 보간한 근사값입니다. major가 길면 요청 지연으로 이어집니다.',
    }),
    timeseries('GC 평균 정지 시간 (종류별)', [[
      `sum by (kind) (rate(nodejs_gc_duration_seconds_sum{${sel}}[5m])) / (sum by (kind) (rate(nodejs_gc_duration_seconds_count{${sel}}[5m])) > 0)`,
      '{{kind}}',
    ]], { unit: 's', min: 0, description: 'GC 한 번당 평균 정지 시간(5분 창).' }),
    timeseries('GC에 쓴 시간 비율 (%)', [[`sum by (kind) (rate(nodejs_gc_duration_seconds_sum{${sel}}[1m]))`, '{{kind}}']], {
      unit: 'percentunit',
      min: 0,
      description: '프로세스 시간 중 GC로 멈춰 있던 비율. 높으면 메모리 압박이 큽니다.',
    }),
    timeseries('힙 메모리', [
      [`sum by (instance) (nodejs_heap_size_used_bytes{${sel}})`, '사용 {{instance}}'],
      [`sum by (instance) (nodejs_heap_size_total_bytes{${sel}})`, '확보 {{instance}}'],
    ], { unit: 'bytes' }),
    timeseries('프로세스 상주 메모리 (RSS)', [[`max by (instance) (process_resident_memory_bytes{${sel}})`, '{{instance}}']], { unit: 'bytes' }),
    timeseries('프로세스 CPU 사용률', [[`sum by (instance) (rate(process_cpu_seconds_total{${sel}}[1m]))`, '{{instance}}']], { unit: 'percentunit', min: 0 }),
    timeseries('활성 핸들·요청', [
      [`sum by (instance) (nodejs_active_handles_total{${sel}})`, '핸들 {{instance}}'],
      [`sum by (instance) (nodejs_active_requests_total{${sel}})`, '요청 {{instance}}'],
    ]),
  ];
}

const LATENCY_THRESHOLDS = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 0.05 }, { color: 'red', value: 0.2 }] };
const GC_OVERHEAD_THRESHOLDS = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 0.05 }, { color: 'red', value: 0.1 }] };
const CPU_THRESHOLDS = { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 0.7 }, { color: 'red', value: 0.9 }] };

/** Six tiles in one row: scrape state first, then the signals that show a struggling runtime. */
function top(s) {
  const sel = `service="${s.name}"`;
  const up = `up{job="eureka-services",${sel}}`;
  const w = 4;
  const common = [
    stat('메트릭 수집 상태', [[`max(${up})`, '']], {
      w,
      description: 'Prometheus가 이 서비스를 긁고 있는지. 인스턴스 중 하나라도 UP이면 UP입니다.',
      mappings: UP_DOWN,
      thresholds: UP_THRESHOLDS,
      colorMode: 'background',
    }),
    stat('UP 인스턴스 수', [[`count(${up} == 1) or vector(0)`, '']], {
      w,
      description: 'Eureka에 등록되어 수집이 되는 인스턴스 수.',
      thresholds: UP_THRESHOLDS,
    }),
  ];
  if (s.runtime === 'jvm') {
    return [
      ...common,
      stat('GC 오버헤드', [[`max(jvm_gc_overhead{${sel}})`, '']], {
        w,
        unit: 'percentunit',
        decimals: 1,
        thresholds: GC_OVERHEAD_THRESHOLDS,
        description: '최근 구간 CPU 시간 중 GC에 쓴 비율(가장 높은 인스턴스). 5%를 넘으면 노랑, 10%를 넘으면 빨강입니다(참고값).',
      }),
      gauge('힙 한도 대비 사용률', `sum(jvm_memory_used_bytes{area="heap",${sel}}) / sum(jvm_memory_max_bytes{area="heap",${sel}} > 0)`, {
        w,
        description: '모든 인스턴스의 힙 사용량 ÷ 힙 한도. 85%를 넘으면 빨간색입니다(참고값).',
      }),
      stat('프로세스 CPU 사용률', [[`max(process_cpu_usage{${sel}})`, '']], {
        w,
        unit: 'percentunit',
        decimals: 0,
        thresholds: CPU_THRESHOLDS,
        description: '가장 바쁜 인스턴스의 CPU 사용률. 70%를 넘으면 노랑, 90%를 넘으면 빨강입니다(참고값).',
      }),
      stat('GC 정지 최대 (2분)', [[`max(jvm_gc_pause_seconds_max{${sel}})`, '']], {
        w,
        unit: 's',
        decimals: 1,
        thresholds: LATENCY_THRESHOLDS,
        description: '최근 약 2분 동안 GC 한 번이 멈춘 가장 긴 시간(모든 인스턴스·수집기 중 최댓값). 50ms를 넘으면 노랑, 200ms를 넘으면 빨강입니다(참고값).',
      }),
    ];
  }
  return [
    ...common,
    stat('이벤트 루프 지연 p99', [[`max(nodejs_eventloop_lag_p99_seconds{${sel}})`, '']], {
      w,
      unit: 's',
      decimals: 1,
      thresholds: LATENCY_THRESHOLDS,
      description: '가장 느린 인스턴스의 이벤트 루프 지연 p99. 50ms를 넘으면 노랑, 200ms를 넘으면 빨강입니다(참고값).',
    }),
    stat('GC 정지 p99 (5분)', [[`histogram_quantile(0.99, sum by (le) (rate(nodejs_gc_duration_seconds_bucket{${sel}}[5m])))`, '']], {
      w,
      unit: 's',
      decimals: 1,
      thresholds: LATENCY_THRESHOLDS,
      description: 'GC 한 번이 멈춘 시간의 p99(모든 종류 합산, 버킷 보간 근사값). 50ms를 넘으면 노랑, 200ms를 넘으면 빨강입니다(참고값).',
    }),
    gauge('힙 확보량 대비 사용률', `sum(nodejs_heap_size_used_bytes{${sel}}) / sum(nodejs_heap_size_total_bytes{${sel}})`, {
      w,
      description: 'V8이 확보한 힙 중 사용 중인 비율. V8은 필요하면 힙을 늘리므로 높다고 바로 위험하지는 않습니다.',
    }),
    stat('Node.js 활성 핸들 수', [[`sum(nodejs_active_handles_total{${sel}})`, '']], { w, colorMode: 'value' }),
  ];
}

export function serviceDashboard(s) {
  const links = [{ title: 'Expo / Overview', uid: 'expo-overview' }];
  if (s.domain) links.push(s.domain);
  links.push({ title: `${s.label} 로그`, uid: 'expo-logs', query: `var-service=${s.name}` });
  return () =>
    dashboard({
      uid: `expo-svc-${s.short}`,
      title: `Expo / ${s.label} (${s.name})`,
      description: `${s.name}의 수집 상태, HTTP, 런타임(${s.runtime === 'jvm' ? 'JVM' : 'Node.js'}).`,
      tags: ['expo', 'service'],
      links,
      variables: [datasourceVariable('prometheus', { name: 'Prometheus', uid: 'prometheus' })],
      panels: [...top(s), ...http(s), ...(s.runtime === 'jvm' ? jvm(s) : node(s))],
    });
}
