#!/usr/bin/env node
import { loadConfig, secretsOf } from './config.mjs';
import { collectAll, buildReport, toMarkdown } from './report.mjs';
import { buildMessages, sendAll } from './discord.mjs';
import { nextRun, parseSpec } from './schedule.mjs';
import { scrub } from './http.mjs';

const MAX_TIMER_MS = 3600_000; // wake hourly and re-check the clock, so suspend/clock jumps cannot skew a run

export async function runOnce(cfg, kind, { dryRun = false, fetchImpl = fetch, sleep, out = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const data = await collectAll(cfg, kind, { dryRun, fetchImpl });
  const report = buildReport(data, cfg);
  const messages = buildMessages({ ...report, imageNames: report.images.map((i) => i.name) });
  if (dryRun) {
    out(JSON.stringify(messages, null, 2));
    out('\n--- markdown preview ---\n');
    out(toMarkdown(report));
    return { report, messages };
  }
  if (!cfg.discordWebhookUrl) throw new Error('DISCORD_WEBHOOK_URL 미설정');
  const files = Object.fromEntries(report.images.map((i) => [i.name, i.buffer]));
  await sendAll(cfg.discordWebhookUrl, messages, files, { fetchImpl, sleep });
  out(`[digest] ${kind} 전송 완료 (판정: ${report.verdict.label}, 메시지 ${messages.length}개, 이미지 ${report.images.length}장)`);
  return { report, messages };
}

function safeLog(cfg, msg) {
  console.error(scrub(msg, secretsOf(cfg)));
}

async function serve(cfg) {
  const jobs = [];
  if (cfg.dailyAt.toLowerCase() !== 'off') jobs.push({ kind: 'daily', spec: parseSpec(cfg.dailyAt) });
  if (cfg.weeklyAt.toLowerCase() !== 'off') jobs.push({ kind: 'weekly', spec: parseSpec(cfg.weeklyAt, { weekly: true }) });
  if (!jobs.length) throw new Error('예약된 작업이 없음');
  for (const job of jobs) {
    const loop = (after = Date.now()) => {
      const target = nextRun(after, job.spec, cfg.tz); // recomputed from the wall clock every cycle
      if (!job.logged) console.log(`[digest] ${job.kind} 다음 실행: ${new Date(target).toISOString()}`);
      const tick = () => {
        const left = target - Date.now();
        if (left > 0) return setTimeout(tick, Math.min(left, MAX_TIMER_MS));
        runOnce(cfg, job.kind)
          .catch((e) => safeLog(cfg, `[digest] ${job.kind} 실패: ${e?.message ?? e?.name}`))
          .finally(() => loop(Math.max(Date.now(), target + 1000)));
      };
      setTimeout(tick, Math.min(Math.max(target - Date.now(), 0), MAX_TIMER_MS));
    };
    loop();
  }
}

async function main(argv) {
  const cfg = loadConfig();
  const [cmd, kind, ...flags] = argv;
  if (cmd === 'once' && (kind === 'daily' || kind === 'weekly')) {
    await runOnce(cfg, kind, { dryRun: flags.includes('--dry-run') });
  } else if (cmd === 'serve') {
    await serve(cfg);
  } else {
    console.error('usage: node digest/index.mjs once daily|weekly [--dry-run] | serve');
    process.exitCode = 2;
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cfg = loadConfig();
  main(process.argv.slice(2)).catch((e) => {
    safeLog(cfg, `[digest] 실패: ${e?.message ?? e?.name}`);
    process.exitCode = 1;
  });
}
