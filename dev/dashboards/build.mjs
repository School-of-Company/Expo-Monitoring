// Generates the dashboards listed in DASHBOARDS into grafana/dashboards/. Edit this file, not the JSON:
//   node dev/dashboards/build.mjs          write the JSON files
//   node dev/dashboards/build.mjs --check  fail if a committed JSON differs from what this file generates (CI)
// Hand-written dashboards (msa-overview, gateway, attendance, form) are not touched.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { overview } from './overview.mjs';
import { SERVICES, serviceDashboard } from './services.mjs';
import { logsDashboard } from './logs.mjs';

const DASHBOARDS = [overview, ...SERVICES.map(serviceDashboard), logsDashboard];

const outDir = fileURLToPath(new URL('../../grafana/dashboards/', import.meta.url));
const check = process.argv.includes('--check');
let stale = 0;
for (const build of DASHBOARDS) {
  const dashboard = build();
  const file = `${outDir}${dashboard.uid}.json`;
  const text = `${JSON.stringify(dashboard, null, 2)}\n`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(file, 'utf8');
    } catch {}
    if (current !== text) {
      console.error(`stale: ${file} (run node dev/dashboards/build.mjs)`);
      stale += 1;
    }
  } else {
    writeFileSync(file, text);
    console.log(`wrote ${file}`);
  }
}
process.exit(stale === 0 ? 0 : 1);
