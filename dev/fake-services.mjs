// Demo only: a fake Eureka (GET /eureka/apps, XML like the real one) plus fake
// services exposing Micrometer-style http_server_requests_seconds. One
// instance has prometheus.scrape=false to show the opt-in filter.
import http from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';

const HOST = process.env.ADVERTISE_IP ?? Object.values(networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address ?? '127.0.0.1';
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1];

// runtime: which default metrics the service exposes (Spring Micrometer or Node prom-client).
const services = [
  { app: 'EXPO-FORM-SERVER', id: 'form-1', port: 9101, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true, runtime: 'node' },
  { app: 'EXPO-FORM-SERVER', id: 'form-2', port: 9102, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true, runtime: 'node' },
  { app: 'EXPO-APPLICATION-SERVER', id: 'application-1', port: 9103, rps: 5, errorRate: 0.1, scrape: true, runtime: 'jvm' },
  { app: 'EXPO-REPORT-SERVER', id: 'report-1', port: 9104, rps: 1, errorRate: 0, scrape: false, runtime: 'jvm' },
  { app: 'EXPO-GATEWAY', id: 'gateway-1', port: 9105, rps: 8, errorRate: 0, scrape: true, runtime: 'node' },
  { app: 'NO-PORT', id: 'no-port', port: 9106, rps: 1, errorRate: 0, scrape: true, omitPort: true, runtime: 'jvm' },
  { app: 'NO-OPT-IN', id: 'no-opt-in', port: 9107, rps: 1, errorRate: 0, omitScrape: true, runtime: 'jvm' },
  { app: 'EXPO-ATTENTION-SERVER', id: 'attendance-1', port: 9108, rps: 8, errorRate: 0, path: '/actuator/prometheus', scrape: true, runtime: 'jvm' },
];
const hidden = new Set();
let demoExhausted = false;

// Demo logs in the Expo log standard (docs/logging.md): one JSON object per line.
// expo-form-server writes a PM2-style file (production layout, with PM2's "<time>: " prefix), expo-application-server
// the local-profile mirror (<service>/app.log). The messages carry a phone number, a long
// token and a trace id on purpose, to prove masking. legacy-out.log is a service that
// does not follow the standard: its lines must arrive without service/level labels.
const LOG_DIR = process.env.LOG_DIR;
if (LOG_DIR) {
  mkdirSync(`${LOG_DIR}/expo-application-server`, { recursive: true });
  const entry = (service, level, module, message) =>
    JSON.stringify({ '@timestamp': new Date().toISOString(), level, service, module, message });
  const lines = [
    (s) => entry(s, 'INFO', 'survey', `form submitted phone=010-1234-5678 trace=${randomBytes(16).toString('hex')}`),
    (s) => entry(s, 'WARN', 'client', 'retry sms to 01098765432 Authorization: Bearer abcDEF123456789xyz'),
    (s) => entry(s, 'ERROR', 'outbox', `outbox publish failed token=${randomBytes(24).toString('hex')} trace=${randomBytes(16).toString('hex')}`),
  ];
  // PM2 with a log date format prefixes each captured line with "<time>: " like production.
  const pm2Prefix = () => `${new Date().toISOString().slice(0, 19)}: `;
  const files = {
    'expo-form-server': { file: `${LOG_DIR}/expo-form-server-out.log`, prefix: pm2Prefix },
    'expo-application-server': { file: `${LOG_DIR}/expo-application-server/app.log`, prefix: () => '' },
  };
  setInterval(() => {
    for (const [name, { file, prefix }] of Object.entries(files)) {
      appendFileSync(file, lines.map((l) => prefix() + l(name)).join('\n') + '\n');
    }
    appendFileSync(`${LOG_DIR}/legacy-out.log`, `${new Date().toISOString()} ERROR [legacy] plain text line\n`);
  }, 2000);
}

for (const s of services) {
  s.counts = { '200': 0, '500': 0 };
  s.buckets = BUCKETS.map(() => 0);
  s.total = 0;
  s.sum = 0;
}

setInterval(() => {
  for (const s of services) {
    const n = Math.round(s.rps * (0.8 + Math.random() * 0.4));
    for (let i = 0; i < n; i++) {
      const latency = 0.02 + Math.random() * Math.random() * 0.4;
      s.counts[Math.random() < s.errorRate ? '500' : '200']++;
      s.total++;
      s.sum += latency;
      BUCKETS.forEach((le, j) => {
        if (latency <= le) s.buckets[j]++;
      });
    }
  }
}, 1000);

// Runtime metrics with the names and labels the real services expose (Spring Boot 4.1 Micrometer, prom-client 15).
function jvmMetrics(s) {
  const out = [
    'process_cpu_usage 0.12',
    'jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} 150000000',
    'jvm_memory_used_bytes{area="heap",id="G1 Old Gen"} 90000000',
    'jvm_memory_used_bytes{area="nonheap",id="Metaspace"} 80000000',
    'jvm_memory_committed_bytes{area="heap",id="G1 Eden Space"} 200000000',
    'jvm_memory_committed_bytes{area="heap",id="G1 Old Gen"} 150000000',
    // G1 reports -1 (no limit) for the young spaces; only the old gen has a max.
    'jvm_memory_max_bytes{area="heap",id="G1 Eden Space"} -1',
    'jvm_memory_max_bytes{area="heap",id="G1 Old Gen"} 536870912',
    'jvm_gc_overhead 0.01',
    `jvm_gc_memory_allocated_bytes_total ${s.total * 200000}`,
    'jvm_threads_live_threads 42',
    'jvm_threads_daemon_threads 30',
    'jvm_threads_peak_threads 45',
    'hikaricp_connections_active{pool="HikariPool-1"} 2',
    'hikaricp_connections_idle{pool="HikariPool-1"} 8',
    'hikaricp_connections_pending{pool="HikariPool-1"} 0',
    'hikaricp_connections_max{pool="HikariPool-1"} 10',
  ];
  if (s.app === 'EXPO-APPLICATION-SERVER') {
    for (const operation of ['GET', 'SET']) {
      out.push(`lettuce_seconds_count{db_operation="${operation}",db_system="redis"} ${s.total}`, `lettuce_seconds_sum{db_operation="${operation}",db_system="redis"} ${s.total * 0.0004}`);
    }
  }
  return out;
}

function gcDuration(kind, count, sum, bucket) {
  const out = [];
  for (const le of ['0.001', '0.01', '0.1', '1', '2', '5', '+Inf']) {
    out.push(`nodejs_gc_duration_seconds_bucket{kind="${kind}",le="${le}"} ${le === '+Inf' || Number(le) >= bucket ? count : 0}`);
  }
  out.push(`nodejs_gc_duration_seconds_sum{kind="${kind}"} ${sum}`, `nodejs_gc_duration_seconds_count{kind="${kind}"} ${count}`);
  return out;
}

function nodeMetrics(s) {
  return [
    'nodejs_eventloop_lag_seconds 0.001',
    'nodejs_eventloop_lag_p50_seconds 0.0011',
    'nodejs_eventloop_lag_p90_seconds 0.0016',
    'nodejs_eventloop_lag_p99_seconds 0.002',
    'nodejs_eventloop_lag_max_seconds 0.004',
    'process_resident_memory_bytes 50000000',
    'nodejs_heap_size_used_bytes 10000000',
    'nodejs_heap_size_total_bytes 16000000',
    `process_cpu_seconds_total ${s.total / 100}`,
    // prom-client's GC histogram buckets (0.001, 0.01, 0.1, 1, 2, 5): minor pauses fall in 0.01 s, major in 0.1 s.
    ...gcDuration('minor', s.total / 10, s.total / 5000, 0.01),
    ...gcDuration('major', s.total / 100, s.total / 20000, 0.1),
    'nodejs_active_handles_total 12',
    'nodejs_active_requests_total 0',
  ];
}

function render(s) {
  const out = [];
  const attendance = s.app === 'EXPO-ATTENTION-SERVER';
  const method = attendance ? 'PATCH' : 'GET';
  const uri = attendance ? '/attendance/{expoId}' : '/forms/{id}';
  if (s.app === 'EXPO-GATEWAY') {
    out.push(`gateway_http_requests_total{app="demo",status="200"} ${s.total}`);
    for (const [index, le] of BUCKETS.entries()) out.push(`gateway_http_request_duration_seconds_bucket{app="demo",status_class="2xx",le="${le}"} ${s.buckets[index]}`);
    out.push(`gateway_http_request_duration_seconds_bucket{app="demo",status_class="2xx",le="+Inf"} ${s.total}`);
    out.push(`gateway_http_request_duration_seconds_sum{app="demo",status_class="2xx"} ${s.sum}`, `gateway_http_request_duration_seconds_count{app="demo",status_class="2xx"} ${s.total}`);
    out.push('gateway_upstream_healthy_instances{app="demo"} 1');
  } else {
    out.push('# TYPE http_server_requests_seconds histogram');
    for (const [status, v] of Object.entries(s.counts).filter(([status]) => status !== '500' || s.errorRate > 0)) {
      out.push(`http_server_requests_seconds_count{method="${method}",status="${status}",uri="${uri}"} ${v}`);
    }
    BUCKETS.forEach((le, j) => {
      out.push(`http_server_requests_seconds_bucket{method="${method}",status="200",uri="${uri}",le="${le}"} ${s.buckets[j]}`);
    });
    out.push(`http_server_requests_seconds_bucket{method="${method}",status="200",uri="${uri}",le="+Inf"} ${s.total}`);
    out.push(`http_server_requests_seconds_sum{method="${method}",status="200",uri="${uri}"} ${s.sum}`);
  }
  if (attendance) {
    out.push(...out.filter((line) => line.startsWith('http_server_requests_seconds_')).map((line) => line.replaceAll('/attendance/{expoId}', '/attendance/qr/{expoId}')));
    out.push(`http_server_requests_seconds_count{method="GET",status="503",uri="/attendance/{expoId}"} ${s.total}`);
    out.push(`http_server_requests_seconds_count{method="PATCH",status="503",uri="/attendance/standard/{programId}"} ${s.total}`);
    for (const service of ['user', 'expo', 'application']) {
      out.push(`attendance_circuit_breaker_state{name="${service}"} 0`);
      out.push(`attendance_circuit_breaker_failure_rate{name="${service}"} 0`);
      out.push(`attendance_circuit_breaker_slow_call_rate{name="${service}"} 0`);
      for (const outcome of ['success', 'not_found', 'conflict', 'circuit_open', 'failure']) {
        out.push(`attendance_downstream_calls_seconds_count{service="${service}",outcome="${outcome}"} ${outcome === 'success' ? s.total : 0}`);
      }
    }
    for (const kind of ['scan', 'cancel']) {
      out.push(`attendance_guard_lock_wait_seconds_count{kind="${kind}"} ${s.total}`);
      for (const le of ['0.01', '0.5', '1', '+Inf']) out.push(`attendance_guard_lock_wait_seconds_bucket{kind="${kind}",le="${le}"} ${s.total}`);
    }
    out.push('attendance_qr_entry_pending 0');
  }
  if (s.app === 'EXPO-FORM-SERVER') {
    // Names and labels follow Expo-Form-Server src/metrics. form-1 has a stuck answer outbox
    // (demo of the Grafana alert). POST /demo/exhausted/on|off toggles EXHAUSTED records (shared DB).
    out.push(`form_outbox_oldest_pending_age_seconds{outbox="answer"} ${s.id === 'form-1' ? 900 : 0}`, 'form_outbox_oldest_pending_age_seconds{outbox="draw"} 0');
    const exhausted = demoExhausted ? 2 : 0;
    out.push('form_outbox_records{outbox="answer",state="received"} 3', 'form_outbox_records{outbox="answer",state="published"} 100', `form_outbox_records{outbox="answer",state="exhausted"} ${exhausted}`);
    out.push('form_outbox_records{outbox="draw",state="unpublished"} 0', 'form_outbox_records{outbox="draw",state="exhausted"} 0');
    out.push('form_db_pool_connections{state="total"} 10', 'form_db_pool_connections{state="idle"} 8', 'form_db_pool_connections{state="waiting"} 0');
    for (const outbox of ['answer', 'draw']) {
      out.push(`form_outbox_relay_runs_total{outbox="${outbox}",result="ok"} ${s.total}`, `form_outbox_relay_runs_total{outbox="${outbox}",result="error"} 0`, `form_outbox_relay_runs_total{outbox="${outbox}",result="skipped"} 0`);
      out.push(`form_outbox_publish_total{outbox="${outbox}",result="ok"} ${s.total}`, `form_outbox_publish_total{outbox="${outbox}",result="error"} 0`);
    }
    out.push('form_result_consumer_skipped_total{reason="unparsable"} 0', 'form_result_consumer_skipped_total{reason="unknown_status"} 0');
    // Public survey routes (route templates).
    for (const [method, publicUri] of [['GET', '/surveys/public/:expoId'], ['POST', '/surveys/answer/public/:expoId']]) {
      out.push(`http_server_requests_seconds_count{method="${method}",status="200",uri="${publicUri}"} ${s.total}`);
      BUCKETS.forEach((le, j) => out.push(`http_server_requests_seconds_bucket{method="${method}",status="200",uri="${publicUri}",le="${le}"} ${s.buckets[j]}`));
      out.push(`http_server_requests_seconds_bucket{method="${method}",status="200",uri="${publicUri}",le="+Inf"} ${s.total}`);
    }
    // The metric's own `service` label (expo|user) collides with the Eureka label: Prometheus renames it exported_service.
    for (const [downstream, operation] of [['expo', 'exists'], ['expo', 'find_period'], ['user', 'survey_answer_result']]) {
      for (const outcome of ['success', 'not_found', 'conflict', 'timeout', 'failure']) {
        out.push(`form_downstream_calls_seconds_count{service="${downstream}",operation="${operation}",outcome="${outcome}"} ${outcome === 'success' ? s.total : 0}`);
      }
      BUCKETS.forEach((le, j) => out.push(`form_downstream_calls_seconds_bucket{service="${downstream}",operation="${operation}",outcome="success",le="${le}"} ${s.buckets[j]}`));
      out.push(`form_downstream_calls_seconds_bucket{service="${downstream}",operation="${operation}",outcome="success",le="+Inf"} ${s.total}`);
    }
  }
  out.push(...(s.runtime === 'jvm' ? jvmMetrics(s) : nodeMetrics(s)));
  return out.join('\n') + '\n';
}

for (const s of services) {
  http
    .createServer((req, res) => {
      res.writeHead(req.url === (s.path ?? '/metrics') ? 200 : 404).end(req.url === (s.path ?? '/metrics') ? render(s) : '');
    })
    .listen(s.port);
}

function instanceXml(s) {
  const meta = `${s.omitScrape ? '' : `<prometheus.scrape>${s.scrape ? 'true' : 'false'}</prometheus.scrape>`}${s.omitPort ? '' : `<prometheus.port>${s.port}</prometheus.port>`}${s.path ? `<prometheus.path>${s.path}</prometheus.path>` : ''}`;
  return `<instance><instanceId>${s.id}</instanceId><hostName>${s.id}</hostName><app>${s.app}</app><ipAddr>${HOST}</ipAddr><status>UP</status><port enabled="true">8080</port><securePort enabled="false">443</securePort><metadata>${meta}</metadata></instance>`;
}

http
  .createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/demo/form-2/hide') {
      hidden.add('form-2');
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && req.url === '/demo/form-2/show') {
      hidden.delete('form-2');
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && (req.url === '/demo/exhausted/on' || req.url === '/demo/exhausted/off')) {
      demoExhausted = req.url.endsWith('/on');
      res.writeHead(204).end();
      return;
    }
    if (req.url?.startsWith('/eureka/apps')) {
      const apps = [...new Set(services.map((s) => s.app))];
      const body =
        '<applications><versions__delta>1</versions__delta><apps__hashcode>UP_1_</apps__hashcode>' +
        apps
          .map((a) => `<application><name>${a}</name>${services.filter((s) => s.app === a && !hidden.has(s.id)).map(instanceXml).join('')}</application>`)
          .join('') +
        '</applications>';
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
      return;
    }
    res.writeHead(404).end();
  })
  .listen(8761);
