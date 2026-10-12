// Demo only: a fake Eureka (GET /eureka/apps, XML like the real one) plus fake
// services exposing Micrometer-style http_server_requests_seconds. One
// instance has prometheus.scrape=false to show the opt-in filter.
import http from 'node:http';
import { networkInterfaces } from 'node:os';

const HOST = process.env.ADVERTISE_IP ?? Object.values(networkInterfaces()).flat().find((address) => address.family === 'IPv4' && !address.internal)?.address ?? '127.0.0.1';
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1];

const services = [
  { app: 'EXPO-FORM-SERVER', id: 'form-1', port: 9101, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true },
  { app: 'EXPO-FORM-SERVER', id: 'form-2', port: 9102, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true },
  { app: 'EXPO-APPLICATION-SERVER', id: 'application-1', port: 9103, rps: 5, errorRate: 0.1, scrape: true },
  { app: 'EXPO-REPORT-SERVER', id: 'report-1', port: 9104, rps: 1, errorRate: 0, scrape: false },
  { app: 'EXPO-GATEWAY', id: 'gateway-1', port: 9105, rps: 8, errorRate: 0, scrape: true },
  { app: 'NO-PORT', id: 'no-port', port: 9106, rps: 1, errorRate: 0, scrape: true, omitPort: true },
  { app: 'NO-OPT-IN', id: 'no-opt-in', port: 9107, rps: 1, errorRate: 0, omitScrape: true },
  { app: 'EXPO-ATTENTION-SERVER', id: 'attendance-1', port: 9108, rps: 8, errorRate: 0, path: '/actuator/prometheus', scrape: true },
];
const hidden = new Set();

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
  out.push('process_cpu_usage 0.12', 'jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} 150000000', 'nodejs_eventloop_lag_seconds 0.001', 'nodejs_eventloop_lag_p99_seconds 0.002', 'process_resident_memory_bytes 50000000', 'nodejs_heap_size_used_bytes 10000000', `process_cpu_seconds_total ${s.total / 100}`);
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
