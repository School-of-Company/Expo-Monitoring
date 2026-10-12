import assert from 'node:assert/strict';

const prometheus = 'http://prometheus:9090';
const grafana = 'http://grafana:3000';
const authorization = `Basic ${Buffer.from(`admin:${process.env.GRAFANA_ADMIN_PASSWORD ?? 'admin'}`).toString('base64')}`;

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

async function eventually(label, check) {
  const deadline = Date.now() + 120_000;
  let failure;
  do {
    try {
      await check();
      console.log(`PASS ${label}`);
      return;
    } catch (error) {
      failure = error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  } while (Date.now() < deadline);
  throw failure;
}

async function targets() {
  return (await json(`${prometheus}/api/v1/targets`)).data.activeTargets;
}

async function query(expression) {
  const result = await json(`${prometheus}/api/v1/query?query=${encodeURIComponent(expression)}`);
  assert.equal(result.status, 'success');
  return result.data.result;
}

await eventually('Eureka opt-in, paths, healthy scrapes and exclusions', async () => {
  const active = await targets();
  assert.deepEqual(active.map((target) => target.labels.instance).sort(), ['application-1', 'form-1', 'form-2', 'gateway-1']);
  assert(active.every((target) => target.health === 'up'));
  assert(active.find((target) => target.labels.instance === 'form-1').scrapeUrl.endsWith('/actuator/prometheus'));
  assert(active.find((target) => target.labels.instance === 'gateway-1').scrapeUrl.endsWith('/metrics'));
  const dropped = (await json(`${prometheus}/api/v1/targets`)).data.droppedTargets;
  assert.deepEqual(dropped.map((target) => target.discoveredLabels.__meta_eureka_app_instance_id).sort(), ['no-opt-in', 'no-port', 'report-1']);
});

try {
  assert.equal((await fetch('http://fake-services:8761/demo/form-2/hide', { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 204);
  await eventually('instance removal without Prometheus reload', async () => {
    assert.deepEqual((await targets()).map((target) => target.labels.instance).sort(), ['application-1', 'form-1', 'gateway-1']);
  });
} finally {
  assert.equal((await fetch('http://fake-services:8761/demo/form-2/show', { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 204);
}
await eventually('instance addition without Prometheus reload', async () => {
  assert.equal((await targets()).length, 4);
});

await eventually('common RED records and zero-error gateway', async () => {
  for (const record of ['service:http_requests:rate1m', 'service:http_errors_5xx:ratio1m', 'service:http_latency_p95:5m']) {
    const samples = await query(record);
    assert.deepEqual(samples.map((sample) => sample.metric.service).sort(), ['expo-application-server', 'expo-form-server', 'expo-gateway']);
    assert(samples.every((sample) => Number.isFinite(Number(sample.value[1]))));
  }
  assert.equal((await query('service:http_errors_5xx:ratio1m{service="expo-gateway"}'))[0].value[1], '0');
  assert.equal((await query('http_server_requests_seconds_count{service="expo-gateway"}')).length, 0);
  assert((await query('gateway_http_requests_total{service="expo-gateway"}')).length > 0);
});

const rules = (await json(`${prometheus}/api/v1/rules`)).data.groups.flatMap((group) => group.rules);
assert.equal(rules.length, 8);
assert(rules.every((rule) => rule.health === 'ok'));
console.log('PASS all three recording and five alert rules loaded');

await eventually('Grafana provisioned dashboards and datasource', async () => {
  const health = await json(`${grafana}/api/health`);
  assert.equal(health.database, 'ok');
  const dashboards = await json(`${grafana}/api/search?type=dash-db`, { Authorization: authorization });
  assert.equal(dashboards.length, 2);
  for (const dashboard of dashboards) {
    const model = (await json(`${grafana}/api/dashboards/uid/${dashboard.uid}`, { Authorization: authorization })).dashboard;
    for (const target of model.panels.flatMap((panel) => panel.targets ?? [])) {
      if (!target.expr) continue;
      const expression = target.expr.replaceAll('$service', '.*').replaceAll('$app', '.*');
      const response = await json(`${grafana}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(expression)}`, { Authorization: authorization });
      assert.equal(response.status, 'success');
      if (/nodejs_|process_(resident|cpu_seconds)/.test(expression) && model.title === 'Expo Gateway') {
        assert(response.data.result.length > 0, expression);
        assert(response.data.result.every((sample) => sample.metric.service === 'expo-gateway'), expression);
      }
    }
  }
});
