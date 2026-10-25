import { getJson, SourceError } from './http.mjs';
import { mask, truncate } from './mask.mjs';

/** Message used for grouping: JSON "msg"/"message" field if present, else the first line. Never the whole entry. */
export function messageOf(line) {
  let text = String(line);
  if (text.trimStart().startsWith('{')) {
    try {
      const o = JSON.parse(text);
      const m = o.message ?? o.msg ?? o.error ?? o.err;
      if (typeof m === 'string') text = m;
    } catch { /* keep raw */ }
  }
  return text.split('\n')[0];
}

/** Group key: masked, volatile numbers collapsed, cut to 80 chars. */
export function groupKey(line) {
  return truncate(mask(messageOf(line)).replace(/\d{2,}/g, '#').replace(/\s+/g, ' ').trim(), 80);
}

export function groupErrors(streams, topN) {
  const counts = new Map();
  let total = 0;
  for (const s of streams) {
    for (const entry of s.values ?? []) {
      const key = groupKey(entry[1]);
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total += 1;
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([message, count]) => ({ message, count }));
  return { total, kinds: counts.size, top };
}

export async function collectLoki(cfg, { endMs, windowSec }, fetchImpl = fetch) {
  const params = new URLSearchParams({
    query: cfg.lokiQuery,
    start: String((endMs - windowSec * 1000) * 1e6),
    end: String(endMs * 1e6),
    limit: String(cfg.lokiLimit),
    direction: 'backward',
  });
  const body = await getJson(`${cfg.lokiUrl.replace(/\/$/, '')}/loki/api/v1/query_range?${params}`, { fetchImpl });
  if (body?.status !== 'success' || body?.data?.resultType !== 'streams') throw new SourceError('응답 형식 오류');
  const g = groupErrors(body.data.result, cfg.logTopN);
  const sampled = body.data.result.reduce((a, s) => a + (s.values?.length ?? 0), 0) >= cfg.lokiLimit;
  return { ...g, sampled };
}
