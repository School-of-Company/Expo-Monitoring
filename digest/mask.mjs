// Masks personal data before anything from logs/annotations reaches the digest.
const RULES = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '***'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g, '***'],
  [/(password|passwd|pwd|token|secret|authorization|api[_-]?key)(["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s"',;}&]+/gi, '$1$2***'],
  [/(?<![\d])(?:\+?82[-. ]?0?|0)1[016789][-. ]?\d{3,4}[-. ]?\d{4}(?!\d)/g, '***'],
  [/\b[A-Za-z0-9_-]{32,}\b/g, '***'],
];

export function mask(text) {
  let out = String(text ?? '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
