import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVector, mergeServices, collectPrometheus } from './prometheus.mjs';
import { groupErrors } from './loki.mjs';
import { summarizeRules, firedFromAnnotations } from './grafana.mjs';
import { loadConfig } from './config.mjs';
import { collectAll, buildReport, judge } from './report.mjs';

const vec = (rows) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([m, v]) => ({ metric: m, value: [1, String(v)] })) } });

test('parseVector drops NaN and rejects bad shapes', () => {
  assert.deepEqual(parseVector(vec([[{ service: 'a' }, 1.5], [{ service: 'b' }, 'NaN']])), [{ labels: { service: 'a' }, value: 1.5 }]);
  assert.throws(() => parseVector({ status: 'error' }), /형식/);
});

test('mergeServices: missing 5xx series means zero errors', () => {
  const rows = mergeServices({
    requests: parseVector(vec([[{ service: 'a' }, 200], [{ service: 'b' }, 100]])),
    errors: parseVector(vec([[{ service: 'b' }, 10]])),
    p95: parseVector(vec([[{ service: 'a' }, 0.4]])),
    upTotal: parseVector(vec([[{ service: 'a' }, 2]])), upCount: parseVector(vec([[{ service: 'a' }, 1]])),
  });
  const a = rows.find((r) => r.service === 'a'); const b = rows.find((r) => r.service === 'b');
  assert.equal(a.errRatio, 0); assert.equal(b.errRatio, 0.1); assert.equal(a.p95, 0.4); assert.equal(b.p95, null); assert.equal(a.instancesUp, 1);
});

test('loki grouping masks PII and uses only the message field', () => {
  const streams = [{ stream: {}, values: [
    ['1', JSON.stringify({ message: 'send failed to 010-1234-5678', body: { phone: '01099998888' } })],
    ['2', JSON.stringify({ message: 'send failed to 010-9999-0000' })],
    ['3', 'user a@b.co not found\nstack trace line'],
  ] }];
  const g = groupErrors(streams, 5);
  assert.equal(g.total, 3);
  assert.deepEqual(g.top[0], { message: 'send failed to ***', count: 2 });
  assert.ok(!JSON.stringify(g).match(/01099998888|a@b\.co|stack trace/));
});

test('grafana rule summary and annotation parsing', () => {
  const s = summarizeRules({ status: 'success', data: { groups: [{ rules: [
    { name: 'a', state: 'inactive', health: 'ok' }, { name: 'b', state: 'firing', health: 'ok', labels: { severity: 'critical' } },
    { name: 'c', state: 'pending', health: 'ok' }, { name: 'd', state: 'inactive', health: 'error' },
  ] }] } });
  assert.deepEqual(s.counts, { normal: 1, pending: 1, firing: 1, error: 1 });
  assert.deepEqual(s.firing, [{ name: 'b', severity: 'critical' }]);
  assert.deepEqual(firedFromAnnotations([{ alertName: 'x', newState: 'Alerting' }, { alertName: 'x', newState: 'Alerting' }, { alertName: 'y', newState: 'Normal' }]), [{ name: 'x', times: 2 }]);
});

// ---- partial failure --------------------------------------------------------
const cfg = loadConfig({ PROMETHEUS_URL: 'http://prom', GRAFANA_URL: 'http://graf', GRAFANA_TOKEN: 'tok', LOKI_URL: 'http://loki' });

function fakeFetch({ failHosts = [] } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (failHosts.includes(u.hostname)) return { ok: false, status: 500, headers: new Headers() };
    const json = (b) => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => b });
    if (u.hostname === 'prom') {
      const q = u.searchParams.get('query');
      if (q.startsWith('sum by (service) (increase(http_server_requests_seconds_count{')) return json(vec([[{ service: 'expo-form' }, 30]]));
      if (q.startsWith('sum by (service) (increase')) return json(vec([[{ service: 'expo-form' }, 1000]]));
      if (q.startsWith('histogram')) return json(vec([[{ service: 'expo-form' }, 0.5]]));
      if (q.startsWith('count by (service) (up{job="eureka-services"} == 1')) return json(vec([[{ service: 'expo-form' }, 2]]));
      if (q.startsWith('count by')) return json(vec([[{ service: 'expo-form' }, 2]]));
      return json(vec([]));
    }
    if (u.pathname.includes('/rules')) return json({ status: 'success', data: { groups: [] } });
    if (u.pathname.includes('/annotations')) return json([]);
    if (u.pathname.startsWith('/render')) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'image/png' }), arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
    if (u.hostname === 'loki') return json({ status: 'success', data: { resultType: 'streams', result: [] } });
    return { ok: false, status: 404, headers: new Headers() };
  };
}

test('one source failing replaces only its section', async () => {
  const data = await collectAll(cfg, 'daily', { dryRun: true, fetchImpl: fakeFetch({ failHosts: ['loki', 'graf'] }) });
  const r = buildReport(data, cfg);
  const names = r.fields.map((f) => f.name);
  assert.ok(names.includes('5xx 비율 상위 5'));
  assert.match(r.fields.find((f) => f.name === '오류 로그').value, /Loki: 수집 실패\(HTTP 500\)/);
  assert.match(r.fields.find((f) => f.name === '알림').value, /Grafana 알림: 수집 실패\(HTTP 500\)/);
  assert.match(r.description, /주의/); // 3% 5xx > 1%
});

test('prometheus failure keeps the other sections', async () => {
  const data = await collectAll(cfg, 'daily', { dryRun: true, fetchImpl: fakeFetch({ failHosts: ['prom'] }) });
  const r = buildReport(data, cfg);
  assert.match(r.fields.find((f) => f.name === 'Prometheus').value, /수집 실패\(HTTP 500\)/);
  assert.ok(r.fields.some((f) => f.name.startsWith('오류 로그 유형')));
  assert.equal(r.images.length, 2);
});

test('verdict thresholds are configurable and strictly greater-than', () => {
  const mk = (ratio) => ({ prom: { value: { services: [{ service: 's', requests: 1000, errors: ratio * 1000, errRatio: ratio, p95: 0.1, instances: 1, instancesUp: 1 }], totals: { requests: 1000, errors: ratio * 1000, errRatio: ratio }, outbox: [], outboxAge: null, poolWaiting: null, alerts: [] } }, alerts: {} });
  assert.equal(judge(mk(0.01), cfg).label, '이상 없음');
  assert.equal(judge(mk(0.011), cfg).label, '주의');
  assert.equal(judge(mk(0.06), cfg).label, '위험');
  assert.equal(judge(mk(0.06), loadConfig({ DIGEST_5XX_CRIT_PCT: '10' })).label, '주의');
  const crit = { prom: { error: 'x' }, alerts: { value: { counts: {}, firing: [{ name: 'a', severity: 'critical' }] } } };
  assert.equal(judge(crit, cfg).label, '위험');
});
