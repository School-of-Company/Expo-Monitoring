import test from 'node:test';
import assert from 'node:assert/strict';
import { nextRun, parseSpec } from './schedule.mjs';

const kst = (s) => Date.parse(`${s}+09:00`);
const iso = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 16);

test('daily: before and after the time today', () => {
  const spec = parseSpec('09:00');
  assert.equal(iso(nextRun(kst('2026-10-21T08:00:00'), spec)), '2026-10-21T09:00');
  assert.equal(iso(nextRun(kst('2026-10-21T09:00:00'), spec)), '2026-10-22T09:00');
  assert.equal(iso(nextRun(kst('2026-10-21T23:59:59'), spec)), '2026-10-22T09:00');
});

test('daily: rolls over month and year end', () => {
  const spec = parseSpec('09:00');
  assert.equal(iso(nextRun(kst('2026-10-31T10:00:00'), spec)), '2026-11-01T09:00');
  assert.equal(iso(nextRun(kst('2026-12-31T10:00:00'), spec)), '2027-01-01T09:00');
  assert.equal(iso(nextRun(kst('2028-02-28T10:00:00'), spec)), '2028-02-29T09:00');
});

test('weekly: MON 09:00 (2026-10-21 is a Wednesday)', () => {
  const spec = parseSpec('MON 09:00', { weekly: true });
  assert.equal(iso(nextRun(kst('2026-10-21T12:00:00'), spec)), '2026-10-26T09:00');
  assert.equal(iso(nextRun(kst('2026-10-26T08:59:00'), spec)), '2026-10-26T09:00');
  assert.equal(iso(nextRun(kst('2026-10-26T09:00:00'), spec)), '2026-11-02T09:00');
  assert.equal(iso(nextRun(kst('2026-12-28T10:00:00'), spec)), '2027-01-04T09:00');
});

test('uses the zone, not the host zone: UTC evening is already next day in KST', () => {
  const spec = parseSpec('09:00');
  // 2026-10-21T20:00Z == 2026-10-22 05:00 KST
  assert.equal(nextRun(Date.parse('2026-10-21T20:00:00Z'), spec), Date.parse('2026-10-22T00:00:00Z'));
});

test('other zone with DST resolves the wall time', () => {
  const spec = parseSpec('09:00');
  // New York is UTC-4 on 2026-10-21 (DST ends 2026-11-01)
  assert.equal(nextRun(Date.parse('2026-10-21T00:00:00Z'), spec, 'America/New_York'), Date.parse('2026-10-21T13:00:00Z'));
  assert.equal(nextRun(Date.parse('2026-11-01T14:30:00Z'), spec, 'America/New_York'), Date.parse('2026-11-02T14:00:00Z'));
});

test('repeated recomputation does not drift', () => {
  const spec = parseSpec('09:00');
  let t = kst('2026-10-21T00:00:00');
  for (let i = 0; i < 400; i += 1) t = nextRun(t + 1234, spec);
  assert.equal(iso(t).slice(11), '09:00');
});

test('invalid specs throw', () => {
  assert.throws(() => parseSpec('25:00'));
  assert.throws(() => parseSpec('MON 09:00'));
  assert.throws(() => parseSpec('XYZ 09:00', { weekly: true }));
});
