// Next-run calculation in a fixed IANA time zone without dependencies.
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function parseSpec(spec, { weekly = false } = {}) {
  const m = String(spec).trim().toUpperCase().match(weekly ? /^([A-Z]{3})\s+(\d{1,2}):(\d{2})$/ : /^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`invalid schedule "${spec}" (expected ${weekly ? 'MON 09:00' : '09:00'})`);
  const [hour, minute] = weekly ? [Number(m[2]), Number(m[3])] : [Number(m[1]), Number(m[2])];
  const day = weekly ? DAYS.indexOf(m[1]) : null;
  if (weekly && day < 0) throw new Error(`invalid weekday in "${spec}"`);
  if (hour > 23 || minute > 59) throw new Error(`invalid time in "${spec}"`);
  return { day, hour, minute };
}

function parts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const o = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]));
  return o;
}

function offsetMs(ms, tz) {
  const p = parts(ms, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

function zonedToUtc(y, mo, d, h, mi, tz) {
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

/** Next instant strictly after `nowMs` matching the spec in `tz`. Recomputed on every call, so no drift accumulates. */
export function nextRun(nowMs, spec, tz = 'Asia/Seoul') {
  const { day, hour, minute } = spec;
  const today = parts(nowMs, tz);
  for (let i = 0; i <= 8; i += 1) {
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day + i));
    if (day !== null && base.getUTCDay() !== day) continue;
    const at = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hour, minute, tz);
    if (at > nowMs) return at;
  }
  throw new Error('no next run found');
}
