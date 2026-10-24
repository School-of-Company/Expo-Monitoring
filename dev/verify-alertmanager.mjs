// Demo only (manual, ~10 min; not part of CI). Run after verify-demo.mjs inside fake-services:
//   docker compose -f docker-compose.yml -f docker-compose.demo.yml exec -T -e GRAFANA_ADMIN_PASSWORD fake-services node /app/verify-alertmanager.mjs
// Checks Alertmanager -> (fake) Discord: firing, grouping, repeat_interval (demo config: 90s critical),
// resolve notification, and that Grafana-managed conditions are not also delivered by Alertmanager.
import assert from 'node:assert/strict';

const prometheus = 'http://prometheus:9090';
const alertmanager = 'http://alertmanager:9093';
const startedAt = Date.now();
// Only entries from this run (the fake webhook keeps earlier runs' deliveries until it restarts).
const received = async () => (await (await fetch('http://localhost:9999/received')).json()).filter((entry) => Date.parse(entry.at) >= startedAt);
const fromAlertmanager = async () => (await received()).filter((entry) => entry.url === '/alertmanager');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(label, check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let failure;
  do {
    try {
      const value = await check();
      console.log(`PASS ${label}`);
      return value;
    } catch (error) {
      failure = error;
      await wait(3000);
    }
  } while (Date.now() < deadline);
  throw failure;
}
const embed = (entry) => JSON.parse(entry.payload).embeds[0];
const mentions = (entry, name) => JSON.stringify(embed(entry)).includes(name);

assert.equal((await fetch('http://localhost:8761/demo/exhausted/on', { method: 'POST' })).status, 204);
console.log('EXHAUSTED switched on; FormOutboxExhausted fires after its 5m "for".');

const first = await eventually('firing notification reaches the webhook as JSON (not multipart)', async () => {
  const hit = (await fromAlertmanager()).find((entry) => mentions(entry, 'FormOutboxExhausted') && !mentions(entry, 'RESOLVED'));
  assert(hit, 'not yet');
  assert.equal(hit.multipart, false);
  return hit;
}, 480_000);
const firstEmbed = embed(first);
console.log('title:', firstEmbed.title);
console.log('description:', JSON.stringify(firstEmbed.description));
assert(firstEmbed.title.startsWith('[CRITICAL] FormOutboxExhausted (expo-form-server)'));
assert(firstEmbed.description.includes('service: `expo-form-server`'));
assert(firstEmbed.description.includes('Dashboard: http://127.0.0.1:3001/d/expo-form'));
assert(firstEmbed.description.includes('Runbook: https://github.com/School-of-Company/Expo-Monitoring/blob/main/docs/runbooks.md#formoutboxexhausted'));
assert.equal((await fromAlertmanager()).filter((entry) => mentions(entry, 'FormOutboxExhausted')).length, 1);

// Grouping: one alertname+service group, even though the same condition exists on two instances (max by).
const active = await (await fetch(`${alertmanager}/api/v2/alerts/groups`)).json();
const group = active.find((g) => g.labels.alertname === 'FormOutboxExhausted');
assert.deepEqual(Object.keys(group.labels).sort(), ['alertname', 'service']);
console.log('PASS grouped by alertname+service:', JSON.stringify(group.labels), `${group.alerts.length} alert(s)`);

await wait(45_000);
const within = (await fromAlertmanager()).filter((entry) => mentions(entry, 'FormOutboxExhausted') && !mentions(entry, 'RESOLVED'));
assert.equal(within.length, 1, `repeated inside repeat_interval: ${within.length}`);
console.log('PASS no repeat 45s after the first notification (demo repeat_interval 90s)');

await eventually('repeat arrives after repeat_interval', async () => {
  const hits = (await fromAlertmanager()).filter((entry) => mentions(entry, 'FormOutboxExhausted') && !mentions(entry, 'RESOLVED'));
  assert(hits.length >= 2, 'no repeat yet');
  const gap = (Date.parse(hits[1].at) - Date.parse(hits[0].at)) / 1000;
  assert(gap >= 85, `gap ${gap}s`);
  console.log(`repeat gap ${gap}s`);
}, 120_000);

// Dedup: ServiceHigh5xxRate fires in Prometheus (application-1 has 10% errors) and in Grafana (image).
await eventually('ServiceHigh5xxRate is active in Alertmanager (Prometheus rule fired)', async () => {
  const alerts = await (await fetch(`${alertmanager}/api/v2/alerts`)).json();
  assert(alerts.some((alert) => alert.labels.alertname === 'ServiceHigh5xxRate'));
}, 120_000);

assert.equal((await fetch('http://localhost:8761/demo/exhausted/off', { method: 'POST' })).status, 204);
await eventually('resolved notification arrives', async () => {
  const hit = (await fromAlertmanager()).find((entry) => mentions(entry, 'RESOLVED') && mentions(entry, 'FormOutboxExhausted'));
  assert(hit, 'not yet');
  console.log('resolved title:', embed(hit).title);
}, 180_000);

// Everything Alertmanager sent must not contain a Grafana-managed condition.
const all = await received();
const am = all.filter((entry) => entry.url === '/alertmanager');
for (const name of ['ServiceHigh5xxRate', 'FormOutboxStalled', 'FormDbPoolExhausted']) {
  assert(!am.some((entry) => mentions(entry, name)), `Alertmanager delivered ${name}`);
}
console.log(`PASS Alertmanager delivered ${am.length} message(s), none for the Grafana-managed conditions`);
const grafana = all.filter((entry) => entry.url === '/webhook');
console.log(`Grafana webhook messages: ${grafana.length}, with PNG: ${grafana.filter((entry) => entry.png).length}, 5xx: ${grafana.filter((entry) => entry.payload.includes('ServiceHigh5xxRate')).length}, stalled: ${grafana.filter((entry) => entry.payload.includes('FormOutboxStalled')).length}`);
console.log(`elapsed ${Math.round((Date.now() - startedAt) / 1000)}s`);
