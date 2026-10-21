import { collectPrometheus } from './prometheus.mjs';
import { collectLoki } from './loki.mjs';
import { collectAlerts, collectDeploys, createSnapshot, renderPanels, dashboardLink, settle } from './grafana.mjs';
import { mask, truncate } from './mask.mjs';

const DAY = 86400;

export async function collectAll(cfg, kind, { now = Date.now(), dryRun = false, fetchImpl = fetch } = {}) {
  const windowSec = kind === 'weekly' ? 7 * DAY : DAY;
  const win = { endMs: now, windowSec };
  const range = { fromMs: now - windowSec * 1000, toMs: now };
  const grafana = Boolean(cfg.grafanaUrl);
  const skipped = { skipped: true };
  const [prom, prev, alerts, deploys, snapshot, images, loki] = await Promise.all([
    cfg.prometheusUrl ? settle(() => collectPrometheus(cfg, win, fetchImpl)) : { error: 'PROMETHEUS_URL 미설정' },
    cfg.prometheusUrl && kind === 'weekly' ? settle(() => collectPrometheus(cfg, { endMs: now - windowSec * 1000, windowSec }, fetchImpl)) : skipped,
    grafana ? settle(() => collectAlerts(cfg, range, fetchImpl)) : skipped,
    grafana ? settle(() => collectDeploys(cfg, range, fetchImpl)) : skipped,
    grafana && !dryRun ? settle(() => createSnapshot(cfg, range, fetchImpl)) : skipped,
    grafana && cfg.panelIds.length ? settle(() => renderPanels(cfg, range, fetchImpl)) : skipped,
    cfg.lokiUrl ? settle(() => collectLoki(cfg, win, fetchImpl)) : skipped,
  ]);
  return { kind, now, range, prom, prev, alerts, deploys, snapshot, images, loki, dryRun };
}

// ---- formatting -----------------------------------------------------------
const nf = new Intl.NumberFormat('en-US');
const int = (n) => nf.format(Math.round(n));
const pct = (r) => `${(r * 100).toFixed(2)}%`;
const secs = (s) => (s < 1 ? `${Math.round(s * 1000)}ms` : `${s.toFixed(2)}s`);
const sign = (n) => (n >= 0 ? '+' : '-');
const dPct = (a, b) => `${sign(a - b)}${(Math.abs(a - b) * 100).toFixed(2)}%p`;
const dRel = (a, b) => (b > 0 ? `${sign(a - b)}${(Math.abs(a - b) / b * 100).toFixed(0)}%` : 'n/a');

export function fmtTime(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const failure = (what, why) => `${what}: 수집 실패(${why})`;

// ---- verdict ---------------------------------------------------------------
export function judge(data, cfg) {
  const t = cfg.thresholds;
  const reasons = [];
  let level = 0; // 0 ok, 1 warn, 2 crit
  const flag = (lv, text) => { level = Math.max(level, lv); reasons.push(text); };
  const p = data.prom.value;
  if (p) {
    const eligible = p.services.filter((s) => s.requests >= cfg.minRequests);
    const worst = [...eligible].sort((a, b) => (b.errRatio ?? 0) - (a.errRatio ?? 0))[0];
    const overall = p.totals.requests >= cfg.minRequests ? p.totals.errRatio : null;
    const top = Math.max(worst?.errRatio ?? 0, overall ?? 0);
    const who = worst && (worst.errRatio ?? 0) >= (overall ?? 0) ? worst.service : '전체';
    if (top * 100 > t.err5xxCritPct) flag(2, `5xx 비율 ${pct(top)} (${who})`);
    else if (top * 100 > t.err5xxWarnPct) flag(1, `5xx 비율 ${pct(top)} (${who})`);
    const slow = [...eligible].filter((s) => s.p95 !== null).sort((a, b) => b.p95 - a.p95)[0];
    if (slow && slow.p95 > t.p95CritSec) flag(2, `p95 ${secs(slow.p95)} (${slow.service})`);
    else if (slow && slow.p95 > t.p95WarnSec) flag(1, `p95 ${secs(slow.p95)} (${slow.service})`);
    const down = p.services.filter((s) => s.instances !== null && s.instancesUp < s.instances);
    if (down.length) flag(1, `인스턴스 down: ${down.map((s) => s.service).join(', ')}`);
    if (p.outboxAge !== null && p.outboxAge > t.outboxAgeCritSec) flag(2, `Form outbox 대기 ${secs(p.outboxAge)}`);
    else if (p.outboxAge !== null && p.outboxAge > t.outboxAgeWarnSec) flag(1, `Form outbox 대기 ${secs(p.outboxAge)}`);
    if (p.poolWaiting !== null && p.poolWaiting >= t.poolWaitingWarn) flag(1, `Form DB 풀 대기 ${int(p.poolWaiting)}`);
    const pa = p.alerts;
    if (pa.some((a) => a.severity === 'critical')) flag(2, 'critical 알림 발화(Prometheus)');
    else if (pa.length) flag(1, `알림 발화 ${pa.length}건(Prometheus)`);
  }
  const g = data.alerts.value;
  if (g) {
    if (g.firing.some((a) => a.severity === 'critical')) flag(2, 'critical 알림 발화(Grafana)');
    else if (g.firing.length) flag(1, `알림 발화 ${g.firing.length}건(Grafana)`);
    if (g.counts.error) flag(1, `알림 규칙 오류 ${g.counts.error}건`);
  }
  const unknown = level === 0 && !p;
  return { level, label: unknown ? '판정 불가' : ['이상 없음', '주의', '위험'][level], reasons };
}

// ---- report ----------------------------------------------------------------
const COLORS = [0x2ecc71, 0xf39c12, 0xe74c3c];

function topLines(services, prevByName, key, n, fmt, prevFmt) {
  return services.slice(0, n).map((s) => {
    const prevRow = prevByName?.get(s.service);
    const extra = prevRow && prevFmt ? prevFmt(s, prevRow) : '';
    return `${s.service}  ${fmt(s)}${extra}`;
  });
}

export function buildReport(data, cfg) {
  const weekly = data.kind === 'weekly';
  const v = judge(data, cfg);
  const p = data.prom.value;
  const prev = data.prev?.value;
  const prevByName = prev ? new Map(prev.services.map((s) => [s.service, s])) : null;
  const fields = [];
  const title = weekly ? `Expo 주간 요약 - 지난주 vs 이번주` : `Expo 일일 요약 - 어제 한눈에`;
  const period = `${fmtTime(data.range.fromMs, cfg.tz)} ~ ${fmtTime(data.range.toMs, cfg.tz)} (${cfg.tz})`;

  // description: verdict + key numbers
  const lines = [`**판정: ${v.label}**${v.reasons.length ? ` - ${v.reasons.slice(0, 4).join(' / ')}` : ''}`];
  if (p) {
    const slowest = [...p.services].filter((s) => s.p95 !== null).sort((a, b) => b.p95 - a.p95)[0];
    const up = p.services.reduce((a, s) => a + s.instancesUp, 0);
    const all = p.services.reduce((a, s) => a + (s.instances ?? 0), 0);
    let l = `요청 ${int(p.totals.requests)}건 · 5xx ${p.totals.errRatio === null ? '-' : pct(p.totals.errRatio)} (${int(p.totals.errors)}건)`;
    if (slowest) l += ` · 최대 p95 ${secs(slowest.p95)} (${slowest.service})`;
    if (all) l += ` · 인스턴스 ${up}/${all} up`;
    lines.push(l);
    if (weekly && prev && prev.totals.requests > 0) {
      let c = `지난주 대비: 요청 ${dRel(p.totals.requests, prev.totals.requests)}`;
      if (p.totals.errRatio !== null && prev.totals.errRatio !== null) c += ` · 5xx ${dPct(p.totals.errRatio, prev.totals.errRatio)}`;
      lines.push(c);
    } else if (weekly) lines.push('지난주 대비: 비교 데이터 없음');
  } else {
    lines.push(failure('Prometheus 수치', data.prom.error));
  }
  lines.push(period);

  // 1. alerts
  const alertLines = [];
  const g = data.alerts.value;
  if (g) {
    alertLines.push(`Grafana 규칙: 정상 ${g.counts.normal} · 대기 ${g.counts.pending} · 발화 ${g.counts.firing} · 오류 ${g.counts.error}`);
    if (g.firing.length) alertLines.push(`발화 중: ${g.firing.map((a) => mask(a.name) + (a.severity ? ` (${a.severity})` : '')).join(', ')}`);
    if (g.fired.length) alertLines.push(`기간 내 발화: ${g.fired.map((a) => `${mask(a.name)} x${a.times}`).join(', ')}`);
  } else if (data.alerts.error) alertLines.push(failure('Grafana 알림', data.alerts.error));
  if (p?.alerts.length) alertLines.push(`Prometheus 알림 발화: ${p.alerts.map((a) => mask(a.name) + (a.severity ? ` (${a.severity})` : '')).join(', ')}`);
  if (alertLines.length) fields.push({ name: '알림', value: alertLines.join('\n') });

  // 2-3. top errors / latency
  if (p) {
    const withReq = p.services.filter((s) => s.requests > 0);
    const errTop = withReq.filter((s) => s.errRatio > 0).sort((a, b) => b.errRatio - a.errRatio);
    fields.push({
      name: `5xx 비율 상위 ${cfg.topN}`,
      value: errTop.length
        ? topLines(errTop, prevByName, 'err', cfg.topN, (s) => `${pct(s.errRatio)} (${int(s.errors)}/${int(s.requests)}건)`, weekly ? (s, o) => (o.errRatio === null ? '' : ` [지난주 ${pct(o.errRatio)}, ${dPct(s.errRatio, o.errRatio)}]`) : null).join('\n')
        : '5xx 없음',
    });
    const slow = p.services.filter((s) => s.p95 !== null).sort((a, b) => b.p95 - a.p95);
    fields.push({
      name: `p95 지연 상위 ${cfg.topN}`,
      value: slow.length
        ? topLines(slow, prevByName, 'p95', cfg.topN, (s) => secs(s.p95), weekly ? (s, o) => (o.p95 === null ? '' : ` [지난주 ${secs(o.p95)}]`) : null).join('\n')
        : '지연 데이터 없음 (히스토그램 필요)',
    });
  } else {
    fields.push({ name: 'Prometheus', value: failure('요청·오류·지연·인스턴스', data.prom.error) });
  }

  // 4. logs
  if (data.loki.value) {
    const l = data.loki.value;
    fields.push({
      name: `오류 로그 유형 상위 ${cfg.logTopN}`,
      value: l.top.length
        ? `${l.top.map((t) => `${int(t.count)}x ${t.message}`).join('\n')}\n(총 ${int(l.total)}건${l.sampled ? ', 표본 상한 도달' : ''}, 개인정보 마스킹됨)`
        : '오류 로그 없음',
    });
  } else if (data.loki.error) fields.push({ name: '오류 로그', value: failure('Loki', data.loki.error) });

  // 5. instances / form
  if (p) {
    const out = [];
    const down = p.services.filter((s) => s.instances !== null && s.instancesUp < s.instances);
    out.push(down.length ? `down: ${down.map((s) => `${s.service} ${s.instancesUp}/${s.instances}`).join(', ')}` : '모든 인스턴스 up');
    if (p.outbox.length) out.push(`Form outbox: ${p.outbox.map((o) => (o.status ? `${o.status} ${int(o.count)}` : int(o.count))).join(', ')}`);
    if (p.outboxAge !== null) out.push(`Form outbox 최장 대기: ${secs(p.outboxAge)}`);
    if (p.poolWaiting !== null) out.push(`Form DB 풀 대기 최대: ${int(p.poolWaiting)}`);
    fields.push({ name: '인스턴스·Form', value: out.join('\n') });
  }

  // 6. deploys
  if (data.deploys.value) {
    const d = data.deploys.value;
    fields.push({
      name: '최근 배포',
      value: d.length ? d.slice(0, 8).map((x) => `${fmtTime(x.time, cfg.tz)}  ${truncate(mask(x.text).replace(/\s+/g, ' '), 100)}`).join('\n') : '기간 내 배포 기록 없음',
    });
  } else if (data.deploys.error) fields.push({ name: '최근 배포', value: failure('Grafana 주석', data.deploys.error) });

  // 7. links
  if (cfg.grafanaUrl) {
    const range = { fromMs: data.range.fromMs, toMs: data.range.toMs };
    const link = dashboardLink(cfg, range);
    const out = [];
    if (data.snapshot.value) out.push(`스냅샷: ${data.snapshot.value.url}`);
    else if (data.snapshot.error) out.push(`${failure('스냅샷', data.snapshot.error)} - 대시보드: ${link}`);
    else out.push(`대시보드: ${link}${data.dryRun ? ' (dry-run: 스냅샷 생성 생략)' : ''}`);
    if (data.images.error) out.push(failure('패널 이미지', data.images.error));
    else if (data.images.value?.failures.length) out.push(`패널 이미지 일부 실패: ${data.images.value.failures.join('; ')}`);
    fields.push({ name: '링크', value: out.join('\n') });
  }

  const images = data.images.value?.images ?? [];
  return {
    verdict: v,
    title,
    description: lines.join('\n'),
    color: COLORS[v.level],
    footer: `${weekly ? 'weekly' : 'daily'} digest`,
    fields,
    images,
  };
}

export function toMarkdown(r) {
  const out = [`# ${r.title}`, '', r.description, ''];
  for (const f of r.fields) out.push(`## ${f.name}`, f.value, '');
  if (r.images.length) out.push(`## 첨부 이미지`, r.images.map((i) => `${i.name} (${i.buffer.length} bytes)`).join('\n'), '');
  return out.join('\n');
}
