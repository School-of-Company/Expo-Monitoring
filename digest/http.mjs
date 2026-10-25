// Tiny fetch helpers. Errors carry one-line causes only - never URLs, headers or bodies.
export class SourceError extends Error {}

export function describeError(e) {
  if (e instanceof SourceError) return e.message;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return '시간 초과';
  const code = e?.cause?.code ?? e?.cause?.errors?.[0]?.code ?? e?.code;
  if (code) return `연결 실패(${code})`;
  return e?.name === 'TypeError' ? '연결 실패' : `${e?.name ?? 'Error'}`;
}

export function scrub(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) out = out.split(s).join('***');
  return out;
}

export async function getJson(url, { headers = {}, timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new SourceError('응답 형식 오류');
  }
}
