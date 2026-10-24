import { getJson, SourceError } from './http.mjs';

/** Instant-vector result -> [{labels, value}] (NaN and non-numeric values dropped). */
export function parseVector(body) {
  if (body?.status !== 'success' || body?.data?.resultType !== 'vector' || !Array.isArray(body.data.result)) {
    throw new SourceError('응답 형식 오류');
  }
  return body.data.result
    .map((r) => ({ labels: r.metric ?? {}, value: Number(r.value?.[1]) }))
    .filter((r) => Number.isFinite(r.value));
}

const byService = (rows) => new Map(rows.map((r) => [r.labels.service ?? '(unknown)', r.value]));

/** Merge per-service query results into one row per service. */
export function mergeServices({ requests, errors, p95, upTotal, upCount }) {
  const req = byService(requests);
  const err = byService(errors);
  const lat = byService(p95);
  const total = byService(upTotal);
  const up = byService(upCount);
  const names = new Set([...req.keys(), ...lat.keys(), ...total.keys()]);
  return [...names].map((service) => {
    const requests_ = req.get(service) ?? 0;
    const errors_ = err.get(service) ?? 0;
    return {
      service,
      requests: requests_,
      errors: errors_,
      errRatio: requests_ > 0 ? errors_ / requests_ : null,
      p95: lat.get(service) ?? null,
      instances: total.get(service) ?? null,
      instancesUp: up.get(service) ?? 0,
    };
  });
}

export function totalsOf(services) {
  const requests = services.reduce((a, s) => a + s.requests, 0);
  const errors = services.reduce((a, s) => a + s.errors, 0);
  return { requests, errors, errRatio: requests > 0 ? errors / requests : null };
}

export async function collectPrometheus(cfg, { endMs, windowSec }, fetchImpl = fetch) {
  const base = cfg.prometheusUrl.replace(/\/$/, '');
  const time = (endMs / 1000).toFixed(3);
  const q = async (expr) => parseVector(await getJson(`${base}/api/v1/query?${new URLSearchParams({ query: expr, time })}`, { fetchImpl }));
  const W = `${windowSec}s`;
  const [requests, errors, p95, upTotal, upCount] = await Promise.all([
    q(`sum by (service) (increase(http_server_requests_seconds_count[${W}])) or sum by (service) (increase(gateway_http_requests_total[${W}]))`),
    q(`sum by (service) (increase(http_server_requests_seconds_count{status=~"5.."}[${W}])) or sum by (service) (increase(gateway_http_requests_total{status=~"5.."}[${W}]))`),
    q(`histogram_quantile(0.95, sum by (service, le) (rate(http_server_requests_seconds_bucket[${W}]))) or histogram_quantile(0.95, sum by (service, le) (rate(gateway_http_request_duration_seconds_bucket[${W}])))`),
    q('count by (service) (up{job="eureka-services"})'),
    q('count by (service) (up{job="eureka-services"} == 1)'),
  ]);
  const optional = async (expr) => {
    try { return await q(expr); } catch { return []; }
  };
  const [outbox, outboxAge, poolWaiting, alerts] = await Promise.all([
    optional('sum by (status) (form_outbox_records)'),
    optional(`max(max_over_time(form_outbox_oldest_pending_age_seconds[${W}]))`),
    optional(`max(max_over_time(form_db_pool_connections{state="waiting"}[${W}]))`),
    optional(`max by (alertname, severity) (max_over_time(ALERTS{alertstate="firing"}[${W}]))`),
  ]);
  const services = mergeServices({ requests, errors, p95, upTotal, upCount });
  return {
    services,
    totals: totalsOf(services),
    outbox: outbox.map((r) => ({ status: r.labels.status ?? '', count: r.value })),
    outboxAge: outboxAge[0]?.value ?? null,
    poolWaiting: poolWaiting[0]?.value ?? null,
    alerts: alerts.map((r) => ({ name: r.labels.alertname ?? '?', severity: r.labels.severity ?? '' })),
  };
}
