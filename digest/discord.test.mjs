import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessages, postMessage, retryDelayMs, LIMITS } from './discord.mjs';

const textSize = (e) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);

function assertLimits(messages) {
  for (const m of messages) {
    assert.ok(m.embeds.length <= LIMITS.embedsPerMessage);
    assert.ok(m.embeds.reduce((a, e) => a + textSize(e), 0) <= LIMITS.total, 'message total');
    for (const e of m.embeds) {
      assert.ok((e.title ?? '').length <= 256);
      assert.ok((e.description ?? '').length <= 4096);
      assert.ok((e.fields ?? []).length <= 25);
      for (const f of e.fields ?? []) { assert.ok(f.name.length <= 256 && f.value.length <= 1024); assert.ok(f.value.length > 0); }
    }
  }
}

test('truncates oversized strings', () => {
  const m = buildMessages({ title: 'x'.repeat(500), description: 'y'.repeat(9000), color: 1, fields: [{ name: 'n'.repeat(400), value: 'v'.repeat(3000) }] });
  assertLimits(m);
  assert.equal(m.length, 1);
});

test('splits across messages by priority, keeps order', () => {
  const fields = Array.from({ length: 30 }, (_, i) => ({ name: `f${i}`, value: 'v'.repeat(1000) }));
  const m = buildMessages({ title: 't', description: 'd'.repeat(4000), color: 1, fields });
  assertLimits(m);
  assert.ok(m.length >= 2 && m.length <= 3);
  assert.equal(m[0].embeds[0].fields[0].name, 'f0');
  const flat = m.flatMap((x) => x.embeds.flatMap((e) => e.fields ?? [])).map((f) => f.name);
  assert.deepEqual(flat, flat.slice().sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))));
});

test('drops lowest priority beyond 3 messages and says so', () => {
  const fields = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, value: 'v'.repeat(1000) }));
  const m = buildMessages({ title: 't', description: 'd', color: 1, fields });
  assertLimits(m);
  assert.equal(m.length, 3);
  assert.match(m[2].embeds[0].footer.text, /생략/);
});

test('25 field cap per embed', () => {
  const m = buildMessages({ title: 't', description: 'd', color: 1, fields: Array.from({ length: 40 }, (_, i) => ({ name: 'a', value: 'b' })) });
  assertLimits(m);
  assert.equal(m[0].embeds[0].fields.length, 25);
});

test('images attach via attachment:// on first message', () => {
  const m = buildMessages({ title: 't', description: 'd', color: 1, fields: [], imageNames: ['a.png', 'b.png'] });
  assert.deepEqual(m[0].images, ['a.png', 'b.png']);
  assert.equal(m[0].embeds[1].image.url, 'attachment://a.png');
});

const res = (status, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers) });
const msg = { embeds: [{ title: 't' }], images: [] };

test('retry: 429 honours Retry-After (capped), then succeeds', async () => {
  const waits = [];
  const seq = [res(429, { 'retry-after': '2' }), res(204)];
  await postMessage('https://hook.invalid/secret-token', msg, {}, { fetchImpl: async () => seq.shift(), sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [2000]);
  assert.equal(retryDelayMs('999'), 30000);
});

test('retry: 5xx up to 2 retries then fail without leaking the URL', async () => {
  let calls = 0;
  await assert.rejects(
    postMessage('https://hook.invalid/secret-token', msg, {}, { fetchImpl: async () => { calls += 1; return res(502); }, sleep: async () => {} }),
    (e) => { assert.doesNotMatch(e.message, /secret-token|hook\.invalid/); assert.match(e.message, /502/); return true; },
  );
  assert.equal(calls, 3);
});

test('4xx fails immediately; network errors retry', async () => {
  let calls = 0;
  await assert.rejects(postMessage('https://h/x', msg, {}, { fetchImpl: async () => { calls += 1; return res(400); }, sleep: async () => {} }), /400/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(postMessage('https://h/secret', msg, {}, { fetchImpl: async () => { calls += 1; throw Object.assign(new TypeError('fetch failed https://h/secret'), { cause: { code: 'ECONNRESET' } }); }, sleep: async () => {} }), (e) => { assert.doesNotMatch(e.message, /secret/); return true; });
  assert.equal(calls, 3);
});

test('multipart body carries payload_json and files[0]', async () => {
  let form;
  await postMessage('https://h/x', { embeds: [{ image: { url: 'attachment://p.png' } }], images: ['p.png'] }, { 'p.png': Buffer.from([137, 80, 78, 71]) }, { fetchImpl: async (_u, o) => { form = o.body; return res(204); } });
  assert.ok(form instanceof FormData);
  assert.ok(JSON.parse(form.get('payload_json')).attachments[0].filename === 'p.png');
  assert.equal(form.get('files[0]').size, 4);
});
