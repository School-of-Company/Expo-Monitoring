import { getJson, SourceError, describeError } from './http.mjs';

export function authHeaders(cfg) {
  if (cfg.grafanaToken) return { Authorization: `Bearer ${cfg.grafanaToken}` };
  if (cfg.grafanaUser) return { Authorization: `Basic ${Buffer.from(`${cfg.grafanaUser}:${cfg.grafanaPassword}`).toString('base64')}` };
  return {};
}

/** Run fn; return {value} or {error: one-line cause} so one failing call never stops the digest. */
export async function settle(fn) {
  try {
    return { value: await fn() };
  } catch (e) {
    return { error: describeError(e) };
  }
}

export function publicBase(cfg) {
  return (cfg.grafanaPublicUrl || cfg.grafanaUrl).replace(/\/$/, '');
}

export function dashboardLink(cfg, { fromMs, toMs }) {
  return `${publicBase(cfg)}/d/${encodeURIComponent(cfg.dashboardUid)}?orgId=1&from=${fromMs}&to=${toMs}`;
}

/** Summarise Grafana-managed rule states from /api/prometheus/grafana/api/v1/rules. */
export function summarizeRules(body) {
  if (body?.status !== 'success' || !Array.isArray(body?.data?.groups)) throw new SourceError('응답 형식 오류');
  const counts = { normal: 0, pending: 0, firing: 0, error: 0 };
  const firing = [];
  for (const g of body.data.groups) {
    for (const r of g.rules ?? []) {
      if (r.health === 'error' || r.state === 'error') counts.error += 1;
      else if (r.state === 'firing' || r.state === 'alerting') {
        counts.firing += 1;
        firing.push({ name: r.name, severity: r.labels?.severity ?? '' });
      } else if (r.state === 'pending') counts.pending += 1;
      else counts.normal += 1;
    }
  }
  return { counts, firing };
}

/** Names of rules that went to Alerting within the window (state-history annotations). */
export function firedFromAnnotations(list) {
  const names = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    const state = String(a.newState ?? a.text ?? '');
    if (!/alerting|firing/i.test(state)) continue;
    const name = a.alertName ?? a.title ?? '?';
    names.set(name, (names.get(name) ?? 0) + 1);
  }
  return [...names].map(([name, times]) => ({ name, times }));
}

async function api(cfg, path, fetchImpl) {
  return getJson(`${cfg.grafanaUrl.replace(/\/$/, '')}${path}`, { headers: authHeaders(cfg), fetchImpl });
}

export async function collectAlerts(cfg, { fromMs, toMs }, fetchImpl) {
  const rules = summarizeRules(await api(cfg, '/api/prometheus/grafana/api/v1/rules', fetchImpl));
  let fired = [];
  try {
    fired = firedFromAnnotations(await api(cfg, `/api/annotations?${new URLSearchParams({ type: 'alert', from: fromMs, to: toMs, limit: 200 })}`, fetchImpl));
  } catch { /* history is best effort */ }
  return { ...rules, fired };
}

export async function collectDeploys(cfg, { fromMs, toMs }, fetchImpl) {
  const list = await api(cfg, `/api/annotations?${new URLSearchParams({ tags: 'deploy', from: fromMs, to: toMs, limit: 20 })}`, fetchImpl);
  if (!Array.isArray(list)) throw new SourceError('응답 형식 오류');
  return list.map((a) => ({ time: a.time, text: String(a.text ?? a.title ?? '') })).sort((a, b) => b.time - a.time);
}

function fillVars(expr, dashboard) {
  let out = String(expr ?? '');
  for (const v of dashboard.templating?.list ?? []) {
    const all = v.allValue || '.*';
    out = out.replaceAll(`\${${v.name}}`, all).replaceAll(`$${v.name}`, all);
  }
  return out;
}

/** Local (non-external) snapshot of the dashboard for the window, with data queried from the panels' own datasource. */
export async function createSnapshot(cfg, { fromMs, toMs }, fetchImpl = fetch) {
  const headers = { ...authHeaders(cfg), 'Content-Type': 'application/json' };
  const base = cfg.grafanaUrl.replace(/\/$/, '');
  const { dashboard } = await api(cfg, `/api/dashboards/uid/${encodeURIComponent(cfg.dashboardUid)}`, fetchImpl);
  if (!dashboard) throw new SourceError('대시보드 없음');
  const intervalMs = Math.max(15000, Math.ceil((toMs - fromMs) / 300));
  for (const panel of dashboard.panels ?? []) {
    if (panel.type === 'row' || !panel.targets?.length) continue;
    const queries = panel.targets.filter((t) => t.expr).map((t) => ({
      refId: t.refId, datasource: t.datasource ?? panel.datasource, expr: fillVars(t.expr, dashboard),
      legendFormat: t.legendFormat, range: true, instant: false, intervalMs, maxDataPoints: 300,
    }));
    if (!queries.length) continue;
    const res = await fetchImpl(`${base}/api/ds/query`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ queries, from: String(fromMs), to: String(toMs) }),
    });
    if (!res.ok) continue; // panel stays empty rather than failing the whole snapshot
    const body = await res.json();
    panel.snapshotData = Object.values(body.results ?? {}).flatMap((r) => r.frames ?? []);
    panel.targets = [];
  }
  dashboard.time = { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
  dashboard.timepicker = { ...(dashboard.timepicker ?? {}), hidden: true };
  const res = await fetchImpl(`${base}/api/snapshots`, {
    method: 'POST', headers, signal: AbortSignal.timeout(30000),
    // external stays false: the snapshot lives on this Grafana, never on snapshots.raintank.io
    body: JSON.stringify({ dashboard, name: `digest ${new Date(toMs).toISOString().slice(0, 10)}`, expires: cfg.snapshotExpiresSec, external: false }),
  });
  if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body.key) throw new SourceError('응답 형식 오류');
  // build the link from the key; the response url uses Grafana's internal app_url
  return { url: `${publicBase(cfg)}/dashboard/snapshot/${encodeURIComponent(body.key)}` };
}

export async function renderPanels(cfg, { fromMs, toMs }, fetchImpl = fetch) {
  const images = [];
  const failures = [];
  for (const id of cfg.panelIds) {
    const qs = new URLSearchParams({ orgId: '1', panelId: String(id), from: String(fromMs), to: String(toMs), width: '900', height: '380', theme: 'light', tz: cfg.tz });
    try {
      const res = await fetchImpl(`${cfg.grafanaUrl.replace(/\/$/, '')}/render/d-solo/${encodeURIComponent(cfg.dashboardUid)}/${encodeURIComponent(cfg.dashboardUid)}?${qs}`, {
        headers: authHeaders(cfg), signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new SourceError(`HTTP ${res.status}`);
      if (!String(res.headers.get('content-type')).startsWith('image/png')) throw new SourceError('PNG 아님');
      images.push({ panelId: id, name: `panel-${id}.png`, buffer: Buffer.from(await res.arrayBuffer()) });
    } catch (e) {
      failures.push(`panel ${id}: ${describeError(e)}`);
    }
  }
  if (!images.length && failures.length) throw new SourceError(failures[0]);
  return { images, failures };
}
