// Demo only: a fake Eureka (GET /eureka/apps, XML like the real one) plus fake
// services exposing Micrometer-style http_server_requests_seconds. One
// instance has prometheus.scrape=false to show the opt-in filter.
import http from 'node:http';

const HOST = process.env.ADVERTISE_IP ?? '172.28.0.50';
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1];

const services = [
  { app: 'EXPO-FORM-SERVER', id: 'form-1', port: 9101, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true },
  { app: 'EXPO-FORM-SERVER', id: 'form-2', port: 9102, rps: 8, errorRate: 0.01, path: '/actuator/prometheus', scrape: true },
  { app: 'EXPO-APPLICATION-SERVER', id: 'application-1', port: 9103, rps: 5, errorRate: 0.1, scrape: true },
  { app: 'EXPO-REPORT-SERVER', id: 'report-1', port: 9104, rps: 1, errorRate: 0, scrape: false },
];

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
  const out = ['# TYPE http_server_requests_seconds histogram'];
  for (const [status, v] of Object.entries(s.counts)) {
    out.push(`http_server_requests_seconds_count{method="GET",status="${status}",uri="/forms/{id}"} ${v}`);
  }
  BUCKETS.forEach((le, j) => {
    out.push(`http_server_requests_seconds_bucket{method="GET",status="200",uri="/forms/{id}",le="${le}"} ${s.buckets[j]}`);
  });
  out.push(`http_server_requests_seconds_bucket{method="GET",status="200",uri="/forms/{id}",le="+Inf"} ${s.total}`);
  out.push(`http_server_requests_seconds_sum{method="GET",status="200",uri="/forms/{id}"} ${s.sum}`);
  out.push('process_cpu_usage 0.12', 'jvm_memory_used_bytes{area="heap",id="G1 Eden Space"} 150000000');
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
  const meta = s.scrape
    ? `<prometheus.scrape>true</prometheus.scrape><prometheus.port>${s.port}</prometheus.port>${s.path ? `<prometheus.path>${s.path}</prometheus.path>` : ''}`
    : '<prometheus.scrape>false</prometheus.scrape>';
  return `<instance><instanceId>${s.id}</instanceId><hostName>${s.id}</hostName><app>${s.app}</app><ipAddr>${HOST}</ipAddr><status>UP</status><port enabled="true">8080</port><securePort enabled="false">443</securePort><metadata>${meta}</metadata></instance>`;
}

http
  .createServer((req, res) => {
    if (req.url?.startsWith('/eureka/apps')) {
      const apps = [...new Set(services.map((s) => s.app))];
      const body =
        '<applications><versions__delta>1</versions__delta><apps__hashcode>UP_1_</apps__hashcode>' +
        apps
          .map((a) => `<application><name>${a}</name>${services.filter((s) => s.app === a).map(instanceXml).join('')}</application>`)
          .join('') +
        '</applications>';
      res.writeHead(200, { 'Content-Type': 'application/xml' }).end(body);
      return;
    }
    res.writeHead(404).end();
  })
  .listen(8761);
