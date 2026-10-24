const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v, d = '') => (v === undefined || v === '' ? d : v);

export function loadConfig(env = process.env) {
  return {
    tz: str(env.DIGEST_TZ, 'Asia/Seoul'),
    dailyAt: str(env.DIGEST_DAILY_AT, '09:00'),
    weeklyAt: str(env.DIGEST_WEEKLY_AT, 'MON 09:00'),
    prometheusUrl: str(env.PROMETHEUS_URL),
    grafanaUrl: str(env.GRAFANA_URL),
    grafanaPublicUrl: str(env.GRAFANA_PUBLIC_URL),
    grafanaToken: str(env.GRAFANA_TOKEN),
    grafanaUser: str(env.GRAFANA_USER),
    grafanaPassword: str(env.GRAFANA_PASSWORD),
    lokiUrl: str(env.LOKI_URL),
    lokiQuery: str(env.DIGEST_LOKI_QUERY, '{level="ERROR"}'),
    lokiLimit: num(env.DIGEST_LOKI_LIMIT, 1000),
    discordWebhookUrl: str(env.DISCORD_WEBHOOK_URL),
    dashboardUid: str(env.DIGEST_DASHBOARD_UID, 'msa-overview'),
    panelIds: str(env.DIGEST_PANEL_IDS, '8,10').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0).slice(0, 2),
    snapshotExpiresSec: num(env.DIGEST_SNAPSHOT_EXPIRES_SEC, 7 * 24 * 3600),
    topN: num(env.DIGEST_TOP_N, 5),
    logTopN: num(env.DIGEST_LOG_TOP_N, 5),
    minRequests: num(env.DIGEST_MIN_REQUESTS, 50),
    thresholds: {
      err5xxWarnPct: num(env.DIGEST_5XX_WARN_PCT, 1),
      err5xxCritPct: num(env.DIGEST_5XX_CRIT_PCT, 5),
      p95WarnSec: num(env.DIGEST_P95_WARN_SEC, 1),
      p95CritSec: num(env.DIGEST_P95_CRIT_SEC, 3),
      outboxAgeWarnSec: num(env.DIGEST_OUTBOX_AGE_WARN_SEC, 300),
      outboxAgeCritSec: num(env.DIGEST_OUTBOX_AGE_CRIT_SEC, 1800),
      poolWaitingWarn: num(env.DIGEST_POOL_WAITING_WARN, 1),
    },
  };
}

/** Values that must never appear in logs or error messages. */
export function secretsOf(cfg) {
  return [cfg.discordWebhookUrl, cfg.grafanaToken, cfg.grafanaPassword].filter((s) => s && s.length >= 4);
}
