// Integration check with fake Prometheus / Grafana / Loki / Discord (real API shapes).
//   node dev/verify-digest.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SECRET = 'SECRET-WEBHOOK-TOKEN-123';
const vec = (rows) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([m, v]) => ({ metric: m, value: [1, String(v)] })) } });
const seen = { snapshotBody: null, rendered: [], hooks: [], grafanaAuth: [] };
let mode = {};

function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await handler(req, res, Buffer.concat(chunks));
    }).listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}` }));
  });
}
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const prom = await serve((req, res) => {
  if (mode.prom500) return json(res, {}, 500);
  const q = new URL(req.url, 'http://x').searchParams.get('query') ?? '';
  const row = (v, svc = 'expo-form') => [{ service: svc }, v];
  if (q.startsWith('sum by (service) (increase(http_server_requests_seconds_count{')) return json(res, vec([row(40), row(2, 'expo-gateway')]));
  if (q.startsWith('sum by (service) (increase')) return json(res, vec([row(1000), row(5000, 'expo-gateway')]));
  if (q.startsWith('histogram')) return json(res, vec([row(1.4), row(0.3, 'expo-gateway')]));
  if (q.startsWith('count by (service) (up{job="eureka-services"} == 1')) return json(res, vec([row(2), row(1, 'expo-gateway')]));
  if (q.startsWith('count by (service) (up')) return json(res, vec([row(2), row(2, 'expo-gateway')]));
  if (q.startsWith('sum by (status) (form_outbox_records')) return json(res, vec([[{ status: 'pending' }, 7], [{ status: 'failed' }, 1]]));
  if (q.includes('form_outbox_oldest')) return json(res, vec([[{}, 120]]));
  if (q.includes('form_db_pool')) return json(res, vec([]));
  if (q.includes('ALERTS')) return json(res, vec([[{ alertname: 'ServiceHigh5xxRate', severity: 'warning' }, 1]]));
  return json(res, vec([]));
});

const grafana = await serve((req, res, body) => {
  const u = new URL(req.url, 'http://x');
  seen.grafanaAuth.push(req.headers.authorization);
  if (u.pathname === '/api/prometheus/grafana/api/v1/rules') return json(res, { status: 'success', data: { groups: [{ name: 'g', rules: [{ name: 'Form outbox stuck', state: 'firing', health: 'ok', labels: { severity: 'critical' } }, { name: 'ok-rule', state: 'inactive', health: 'ok' }] }] } });
  if (u.pathname === '/api/annotations') {
    return json(res, u.searchParams.get('tags') === 'deploy'
      ? [{ time: Date.now() - 3600e3, text: 'expo-form v1.2.3 deployed by dev@school.kr', tags: ['deploy'] }]
      : [{ alertName: 'Form outbox stuck', newState: 'Alerting' }]);
  }
  if (u.pathname === '/api/dashboards/uid/msa-overview') return json(res, { dashboard: { uid: 'msa-overview', title: 'x', templating: { list: [{ name: 'service', allValue: '.+' }] }, panels: [{ id: 7, type: 'timeseries', datasource: { type: 'prometheus', uid: 'prometheus' }, targets: [{ refId: 'A', expr: 'x{service=~"$service"}' }] }] } });
  if (u.pathname === '/api/ds/query') {
    const b = JSON.parse(body.toString());
    assert.ok(!b.queries[0].expr.includes('$service'));
    return json(res, { results: { A: { frames: [{ schema: { refId: 'A', fields: [] }, data: { values: [] } }] } } });
  }
  if (u.pathname === '/api/snapshots' && req.method === 'POST') {
    if (mode.snapshot500) return json(res, {}, 500);
    seen.snapshotBody = JSON.parse(body.toString());
    return json(res, { key: 'snapkey123', url: 'http://internal:3000/dashboard/snapshot/snapkey123', deleteKey: 'DELETEKEY', deleteUrl: 'http://internal/api/snapshots-delete/DELETEKEY' });
  }
  if (u.pathname.startsWith('/render/d-solo/')) {
    seen.rendered.push(u.searchParams.get('panelId'));
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(PNG);
  }
  return json(res, {}, 404);
});

const loki = await serve((req, res) => {
  if (mode.loki500) return json(res, {}, 500);
  return json(res, { status: 'success', data: { resultType: 'streams', result: [{ stream: { level: 'error' }, values: [
    ['1', JSON.stringify({ message: 'sms send failed to 010-1234-5678', requestBody: { phone: '01012345678' } })],
    ['2', JSON.stringify({ message: 'sms send failed to 010-9999-8888' })],
    ['3', 'db timeout for user kim@school.kr token=abcdefabcdefabcdefabcdefabcdefabcdef'],
  ] }] } });
});

const discord = await serve((req, res, body) => {
  if (!req.url.includes(SECRET)) return json(res, {}, 404);
  if (mode.discord500) return json(res, {}, 500);
  seen.hooks.push({ type: req.headers['content-type'], body });
  res.writeHead(204); res.end();
});

function run(extraEnv = {}, args = ['once', 'daily']) {
  const env = { PATH: process.env.PATH, PROMETHEUS_URL: prom.url, GRAFANA_URL: grafana.url, GRAFANA_TOKEN: 'glsa_faketoken', LOKI_URL: loki.url, DISCORD_WEBHOOK_URL: `${discord.url}/api/webhooks/1/${SECRET}`, ...extraEnv };
  return new Promise((resolve) => {
    const p = spawn('node', [fileURLToPath(new URL('../digest/index.mjs', import.meta.url)), ...args], { env });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}
const payloadOf = (hook) => {
  if (hook.type.startsWith('application/json')) return { text: '', payload: JSON.parse(hook.body.toString()) };
  const text = hook.body.toString('latin1');
  const m = text.match(/name="payload_json"\r\n\r\n([\s\S]*?)\r\n--/);
  return { text, payload: JSON.parse(Buffer.from(m[1], 'latin1').toString('utf8')) };
};
const allText = (p) => JSON.stringify(p.embeds);

let failed = 0;
const step = async (name, fn) => { try { await fn(); console.log(`PASS ${name}`); } catch (e) { failed += 1; console.log(`FAIL ${name}: ${e.message}`); } };

await step('daily: multipart with payload_json + 2 PNG files, all sections filled, PII masked', async () => {
  mode = {}; seen.hooks.length = 0;
  const r = await run();
  assert.equal(r.code, 0, r.out);
  assert.equal(seen.hooks.length, 1);
  const h = seen.hooks[0];
  assert.match(h.type, /^multipart\/form-data; boundary=/);
  const { text, payload } = payloadOf(h);
  assert.ok(text.includes('name="files[0]"') && text.includes('name="files[1]"'));
  assert.ok(h.body.includes(PNG.subarray(0, 8)));
  assert.deepEqual(seen.rendered.sort(), ['10', '8']);
  const all = allText(payload);
  for (const s of ['판정', '알림', '5xx 비율 상위', 'p95 지연 상위', '오류 로그 유형', '최근 배포', '스냅샷: ', 'snapkey123', 'Form outbox', 'expo-form']) assert.ok(all.includes(s), `missing ${s}`);
  assert.ok(payload.embeds.some((e) => e.image?.url === 'attachment://panel-8.png'));
  assert.ok(!/010-1234|01012345678|kim@school|dev@school|abcdefabcdef|DELETEKEY/.test(all));
  assert.ok(!r.out.includes(SECRET));
  assert.equal(seen.snapshotBody.external, false);
  assert.equal(seen.snapshotBody.dashboard.panels[0].snapshotData.length, 1);
  assert.equal(seen.grafanaAuth[0], 'Bearer glsa_faketoken');
});

await step('loki 500: other sections still sent', async () => {
  mode = { loki500: true }; seen.hooks.length = 0;
  const r = await run();
  assert.equal(r.code, 0, r.out);
  const all = allText(payloadOf(seen.hooks[0]).payload);
  assert.match(all, /Loki: 수집 실패\(HTTP 500\)/);
  assert.ok(all.includes('5xx 비율 상위') && all.includes('snapkey123'));
});

await step('prometheus 500 and snapshot 500: still sends, falls back to dashboard link', async () => {
  mode = { prom500: true, snapshot500: true }; seen.hooks.length = 0;
  const r = await run();
  assert.equal(r.code, 0, r.out);
  const all = allText(payloadOf(seen.hooks[0]).payload);
  assert.match(all, /Prometheus/); assert.match(all, /스냅샷: 수집 실패\(HTTP 500\) - 대시보드: /);
  assert.ok(all.includes('오류 로그 유형'));
});

await step('no Loki / Grafana configured: sections omitted', async () => {
  mode = {}; seen.hooks.length = 0;
  const r = await run({ LOKI_URL: '', GRAFANA_URL: '' });
  assert.equal(r.code, 0, r.out);
  const { payload, text } = payloadOf(seen.hooks[0]);
  assert.ok(!allText(payload).includes('오류 로그') && !allText(payload).includes('링크') && !allText(payload).includes('attachment://'));
});

await step('weekly shows last-week comparison', async () => {
  mode = {}; seen.hooks.length = 0;
  const r = await run({}, ['once', 'weekly']);
  assert.equal(r.code, 0, r.out);
  assert.match(allText(payloadOf(seen.hooks[0]).payload), /지난주 대비/);
});

await step('dry-run prints JSON + markdown, sends nothing, creates no snapshot', async () => {
  mode = {}; seen.hooks.length = 0; seen.snapshotBody = null;
  const r = await run({}, ['once', 'daily', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.equal(seen.hooks.length, 0); assert.equal(seen.snapshotBody, null);
  assert.ok(r.out.includes('markdown preview') && r.out.includes('"embeds"'));
  assert.ok(!r.out.includes(SECRET));
});

await step('discord 500: exit 1, webhook secret never printed', async () => {
  mode = { discord500: true };
  const r = await run();
  assert.equal(r.code, 1);
  assert.ok(!r.out.includes(SECRET) && !r.out.includes(discord.url), r.out);
  assert.match(r.out, /Discord 전송 실패 \(HTTP 500/);
});

for (const x of [prom, grafana, loki, discord]) x.s.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
