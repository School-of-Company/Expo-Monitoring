import { truncate } from './mask.mjs';

export const LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, footer: 2048, total: 6000, embedsPerMessage: 10 };
const MAX_MESSAGES = 3;

const sizeOfField = (f) => f.name.length + f.value.length;

/**
 * Lay out one digest into Discord messages that respect every embed limit.
 * `fields` must already be in priority order; lower-priority fields spill into
 * continuation messages, and anything past MAX_MESSAGES is dropped with a note.
 * Image embeds (no text) ride on the first message.
 */
export function buildMessages({ title, description, color, footer, fields, imageNames = [] }) {
  const clean = fields.map((f) => ({
    name: truncate(f.name || '-', LIMITS.fieldName),
    value: truncate(f.value || '-', LIMITS.fieldValue),
    inline: Boolean(f.inline),
  }));
  const head = (t, d) => ({
    title: truncate(t, LIMITS.title),
    ...(d ? { description: truncate(d, LIMITS.description) } : {}),
    color,
    fields: [],
    ...(footer ? { footer: { text: truncate(footer, LIMITS.footer) } } : {}),
  });
  const textSize = (e) => (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + e.fields.reduce((a, f) => a + sizeOfField(f), 0);

  const embeds = [head(title, description)];
  let dropped = 0;
  for (const f of clean) {
    let cur = embeds[embeds.length - 1];
    if (cur.fields.length >= LIMITS.fields || textSize(cur) + sizeOfField(f) > LIMITS.total) {
      if (embeds.length >= MAX_MESSAGES) { dropped += 1; continue; }
      cur = head(`${truncate(title, 200)} (계속)`, '');
      embeds.push(cur);
    }
    cur.fields.push(f);
  }
  if (dropped) {
    const last = embeds[embeds.length - 1];
    last.footer = { text: truncate(`${last.footer?.text ?? ''} · 낮은 우선순위 ${dropped}개 항목 생략`.trim(), LIMITS.footer) };
  }
  const messages = embeds.map((e) => ({ embeds: [e], images: [] }));
  imageNames.slice(0, LIMITS.embedsPerMessage - 1).forEach((name) => {
    messages[0].embeds.push({ image: { url: `attachment://${name}` } });
    messages[0].images.push(name);
  });
  return messages;
}

export class DiscordError extends Error {}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After seconds -> ms, capped at 30s; missing/garbage -> 1s. */
export function retryDelayMs(header) {
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, 30) * 1000 : 1000;
}

/**
 * POST one message (multipart when it has images). Retries only 429 (Retry-After)
 * and 5xx / network errors, at most 2 times. Errors never include the webhook URL.
 */
export async function postMessage(webhookUrl, message, files, { fetchImpl = fetch, sleep = sleepReal } = {}) {
  const payload = { username: 'Expo Digest', allowed_mentions: { parse: [] }, embeds: message.embeds };
  const build = () => {
    if (!message.images.length) return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
    const form = new FormData();
    form.append('payload_json', JSON.stringify({ ...payload, attachments: message.images.map((name, id) => ({ id, filename: name })) }));
    message.images.forEach((name, id) => form.append(`files[${id}]`, new Blob([files[name]], { type: 'image/png' }), name));
    return { headers: {}, body: form };
  };
  let lastReason = '';
  for (let attempt = 0; attempt <= 2; attempt += 1) {
    let wait = 1000 * (attempt + 1);
    try {
      const { headers, body } = build();
      const res = await fetchImpl(webhookUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(30000) });
      if (res.ok) return;
      lastReason = `HTTP ${res.status}`;
      if (res.status === 429) wait = retryDelayMs(res.headers.get('retry-after'));
      else if (res.status < 500) throw new DiscordError(`Discord 전송 실패 (${lastReason})`);
    } catch (e) {
      if (e instanceof DiscordError) throw e;
      lastReason = `네트워크 오류(${e?.cause?.code ?? e?.code ?? e?.name ?? 'unknown'})`;
    }
    if (attempt < 2) await sleep(wait);
  }
  throw new DiscordError(`Discord 전송 실패 (${lastReason}, 재시도 소진)`);
}

export async function sendAll(webhookUrl, messages, files, opts) {
  for (const m of messages) await postMessage(webhookUrl, m, files, opts);
}
