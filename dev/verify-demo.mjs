import assert from 'node:assert/strict';

const prometheus = 'http://prometheus:9090';
const grafana = 'http://grafana:3000';
const authorization = `Basic ${Buffer.from(`admin:${process.env.GRAFANA_ADMIN_PASSWORD ?? 'admin'}`).toString('base64')}`;

async function json(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, `${new URL(url).pathname}: HTTP ${response.status}`);
  return response.json();
}

async function eventually(label, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
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
  const { activeTargets: active, droppedTargets: dropped } = (await json(`${prometheus}/api/v1/targets`)).data;
  assert.deepEqual(active.map((target) => target.labels.instance).sort(), ['application-1', 'attendance-1', 'form-1', 'form-2', 'gateway-1']);
  assert(active.every((target) => target.health === 'up'));
  assert(active.find((target) => target.labels.instance === 'form-1').scrapeUrl.endsWith('/actuator/prometheus'));
  assert(active.find((target) => target.labels.instance === 'gateway-1').scrapeUrl.endsWith('/metrics'));
  assert.equal(active.find((target) => target.labels.instance === 'attendance-1').labels.service, 'expo-attention-server');
  assert(active.find((target) => target.labels.instance === 'attendance-1').scrapeUrl.endsWith(':9108/actuator/prometheus'));
  assert.deepEqual(dropped.map((target) => target.discoveredLabels.__meta_eureka_app_instance_id).sort(), ['no-opt-in', 'no-port', 'report-1']);
});

let removalFailure;
try {
  assert.equal((await fetch('http://fake-services:8761/demo/form-2/hide', { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 204);
  await eventually('instance removal without Prometheus reload', async () => {
    assert.deepEqual((await targets()).map((target) => target.labels.instance).sort(), ['application-1', 'attendance-1', 'form-1', 'gateway-1']);
  });
} catch (error) {
  removalFailure = error;
  throw error;
} finally {
  try {
    assert.equal((await fetch('http://fake-services:8761/demo/form-2/show', { method: 'POST', signal: AbortSignal.timeout(5000) })).status, 204);
  } catch (error) {
    if (removalFailure !== undefined) throw new AggregateError([removalFailure, error], 'Instance removal and restoration both failed');
    throw error;
  }
}
await eventually('instance addition without Prometheus reload', async () => {
  const active = await targets();
  assert.deepEqual(active.map((target) => target.labels.instance).sort(), ['application-1', 'attendance-1', 'form-1', 'form-2', 'gateway-1']);
  assert(active.every((target) => target.health === 'up'));
});

await eventually('common RED records and zero-error gateway', async () => {
  for (const record of ['service:http_requests:rate1m', 'service:http_errors_5xx:ratio1m', 'service:http_latency_p95:5m']) {
    const samples = await query(record);
    assert.deepEqual(samples.map((sample) => sample.metric.service).sort(), ['expo-application-server', 'expo-attention-server', 'expo-form-server', 'expo-gateway']);
    assert(samples.every((sample) => Number.isFinite(Number(sample.value[1]))));
  }
  assert.equal((await query('service:http_errors_5xx:ratio1m{service="expo-gateway"}'))[0].value[1], '0');
  assert.equal((await query('http_server_requests_seconds_count{service="expo-gateway"}')).length, 0);
  assert((await query('gateway_http_requests_total{service="expo-gateway"}')).length > 0);
});

await eventually('all fourteen recording and twenty-one alert rules loaded, Alertmanager connected', async () => {
  const rules = (await json(`${prometheus}/api/v1/rules`)).data.groups.flatMap((group) => group.rules);
  assert.equal(rules.length, 35);
  assert(rules.every((rule) => rule.health === 'ok'));
  const alertmanagers = (await json(`${prometheus}/api/v1/alertmanagers`)).data.activeAlertmanagers;
  assert(alertmanagers.some((am) => am.url.startsWith('http://alertmanager:9093/')));
  assert.equal((await fetch('http://alertmanager:9093/-/ready')).status, 200);
});

await eventually('Form downstream label collision becomes exported_service and form rules are idle', async () => {
  const samples = await query('form_downstream_calls_seconds_count{service="expo-form-server"}');
  assert.deepEqual([...new Set(samples.map((sample) => sample.metric.exported_service))].sort(), ['expo', 'user']);
  assert.deepEqual([...new Set(samples.map((sample) => sample.metric.outcome))].sort(), ['conflict', 'failure', 'not_found', 'success', 'timeout']);
  const rules = (await json(`${prometheus}/api/v1/rules`)).data.groups.find((group) => group.name === 'form').rules;
  assert.equal(rules.filter((rule) => rule.type === 'alerting').length, 10);
  assert(rules.filter((rule) => rule.type === 'alerting').every((rule) => rule.state === 'inactive'));
});

await eventually('Attendance label collision, outcome separation and healthy rule state', async () => {
  const samples = await query('attendance_downstream_calls_seconds_count{service="expo-attention-server"}');
  assert.equal(samples.length, 15);
  assert.deepEqual([...new Set(samples.map((sample) => sample.metric.exported_service))].sort(), ['application', 'expo', 'user']);
  assert.deepEqual([...new Set(samples.map((sample) => sample.metric.outcome))].sort(), ['circuit_open', 'conflict', 'failure', 'not_found', 'success']);
  assert(samples.every((sample) => sample.metric.instance === 'attendance-1'));
  const rates = await query('attendance:downstream_calls:rate5m');
  assert.equal(rates.length, 15);
  assert(rates.filter((sample) => sample.metric.outcome !== 'success').every((sample) => Number(sample.value[1]) === 0));
  const scanErrors = await query('attendance:scan_errors_5xx:ratio5m');
  assert.deepEqual(scanErrors.map((sample) => sample.metric.uri).sort(), ['/attendance/qr/{expoId}', '/attendance/{expoId}']);
  assert(scanErrors.every((sample) => sample.value[1] === '0'));
  const rules = (await json(`${prometheus}/api/v1/rules`)).data.groups.find((group) => group.name === 'attendance').rules;
  assert(rules.filter((rule) => rule.type === 'alerting').every((rule) => rule.state === 'inactive'));
});

await eventually('Grafana provisioned dashboards and datasource', async () => {
  const health = await json(`${grafana}/api/health`);
  assert.equal(health.database, 'ok');
  const dashboards = await json(`${grafana}/api/search?type=dash-db`, { Authorization: authorization });
  assert.equal(dashboards.length, 4);
  for (const dashboard of dashboards) {
    const model = (await json(`${grafana}/api/dashboards/uid/${dashboard.uid}`, { Authorization: authorization })).dashboard;
    for (const target of model.panels.flatMap((panel) => panel.targets ?? [])) {
      if (!target.expr) continue;
      const expression = target.expr.replaceAll('$service', '.*').replaceAll('$app', '.*');
      const response = await json(`${grafana}/api/datasources/proxy/uid/prometheus/api/v1/query?query=${encodeURIComponent(expression)}`, { Authorization: authorization });
      assert.equal(response.status, 'success');
      if (model.title === 'Expo Attendance') {
        assert(response.data.result.length > 0, expression);
        assert(response.data.result.every((sample) => Number.isFinite(Number(sample.value[1]))), expression);
      }
      if (model.title === 'Expo Form') assert(response.data.result.length > 0, expression);
      if (model.title === 'Expo Gateway' && /gateway_http_requests_total\{status="502"\}/.test(expression)) {
        assert(response.data.result.length > 0, expression);
        assert(response.data.result.every((sample) => sample.value[1] === '0'), expression);
      }
      if (/nodejs_|process_(resident|cpu_seconds)/.test(expression) && model.title === 'Expo Gateway') {
        assert(response.data.result.length > 0, expression);
        assert(response.data.result.every((sample) => sample.metric.service === 'expo-gateway'), expression);
      }
    }
  }
});

// --- Logs, traces and alerting (Loki, Tempo, Grafana provisioning, fake webhook) ---
const loki = (path) => json(`${grafana}/api/datasources/proxy/uid/loki${path}`, { Authorization: authorization });

await eventually('Loki datasource is healthy', async () => {
  assert.equal((await json(`${grafana}/api/datasources/uid/loki/health`, { Authorization: authorization })).status, 'OK');
});

await eventually('Loki indexes only job/service/level, read from the standard JSON keys', async () => {
  assert.deepEqual((await loki('/loki/api/v1/labels')).data.sort(), ['job', 'level', 'service']);
  const services = (await loki('/loki/api/v1/label/service/values')).data;
  for (const s of ['expo-form-server', 'expo-application-server']) assert(services.includes(s), s);
  assert.deepEqual((await loki('/loki/api/v1/label/level/values')).data.sort(), ['ERROR', 'INFO', 'WARN']);
  // module is structured metadata, filterable without being a label.
  const outbox = await loki(`/loki/api/v1/query_range?query=${encodeURIComponent('{service="expo-application-server"} | module="outbox"')}&limit=5`);
  assert(outbox.data.result.length > 0 && outbox.data.result.every((s) => s.stream.level === 'ERROR'), 'module filter');
  // No fallback: a non-JSON file arrives with job only, never guessed service/level.
  const legacy = await loki(`/loki/api/v1/query_range?query=${encodeURIComponent('{job="expo", service=""}')}&limit=5`);
  assert(legacy.data.result.length > 0, 'non-standard lines should stay visible');
  assert(legacy.data.result.every((s) => !s.stream.level && s.stream.filename?.endsWith('legacy-out.log')), 'non-standard labels');
  const count = await loki(`/loki/api/v1/query?query=${encodeURIComponent('sum by (service) (count_over_time({service=~".+"}[5m]))')}`);
  assert(count.data.result.length >= 2, 'count_over_time per service');
});

await eventually('Loki has demo logs with masked values', async () => {
  const query = encodeURIComponent('{service="expo-form-server"}');
  const result = await loki(`/loki/api/v1/query_range?query=${query}&limit=50`);
  const streams = result.data.result;
  assert(streams.length > 0, 'no streams');
  const lines = streams.flatMap((stream) => stream.values.map((value) => value[1])).join('\n');
  assert(lines.includes('<phone>') && lines.includes('<token>'), 'masking placeholders missing');
  assert(!/01\d-?\d{3,4}-?\d{4}/.test(lines), 'phone number leaked');
  assert(!/[A-Za-z0-9_-]{40,}/.test(lines) && !/Bearer abc/.test(lines), 'token leaked');
  assert(/trace=[0-9a-f]{32}/.test(lines), 'trace id should stay readable');
});

await eventually('Tempo returns a span sent over OTLP HTTP', async () => {
  const traceId = '0af7651916cd43dd8448eb211c80319c';
  const nano = BigInt(Date.now()) * 1000000n;
  const post = await fetch('http://tempo:4318/v1/traces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'expo-form-server' } }] }, scopeSpans: [{ spans: [{ traceId, spanId: 'b7ad6b7169203331', name: 'demo', kind: 2, startTimeUnixNano: String(nano - 200000000n), endTimeUnixNano: String(nano) }] }] }] }),
  });
  assert.equal(post.status, 200);
  const trace = await json(`${grafana}/api/datasources/proxy/uid/tempo/api/traces/${traceId}`, { Authorization: authorization });
  assert(trace.batches?.length > 0);
}, 90_000);

await eventually('Alerting provisioning: contact point, root policy and rules', async () => {
  const headers = { Authorization: authorization };
  const contacts = await json(`${grafana}/api/v1/provisioning/contact-points`, headers);
  assert(contacts.some((c) => c.name === 'discord' && c.type === 'discord'));
  const policy = await json(`${grafana}/api/v1/provisioning/policies`, headers);
  assert.equal(policy.receiver, 'discord');
  assert.deepEqual(policy.group_by, ['alertname', 'service']);
  const titles = (await json(`${grafana}/api/v1/provisioning/alert-rules`, headers)).map((rule) => rule.title);
  for (const title of ['ServiceHigh5xxRate', 'FormOutboxStalled', 'FormDbPoolExhausted']) assert(titles.includes(title), title);
});

await eventually('Firing alert reaches the webhook with a PNG attachment', async () => {
  const received = await json('http://localhost:9999/received');
  const hit = received.find((entry) => entry.multipart && entry.hasFile && entry.png);
  assert(hit, `no image notification yet (${received.length} received)`);
  assert(hit.payload.includes('FormOutboxStalled'));
}, 300_000);

await eventually('External snapshots are disabled, local ones work', async () => {
  const headers = { Authorization: authorization, 'Content-Type': 'application/json' };
  const { dashboard } = await json(`${grafana}/api/dashboards/uid/expo-form`, headers);
  const create = (external) => fetch(`${grafana}/api/snapshots`, { method: 'POST', headers, body: JSON.stringify({ dashboard, name: 'verify', expires: 60, external }) });
  assert.equal((await create(true)).status, 403);
  assert.equal((await create(false)).status, 200);
});
