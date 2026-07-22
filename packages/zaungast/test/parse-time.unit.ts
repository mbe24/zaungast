// MCP-layer unit tests. parseTime (ISO / relative time-filter parsing) lives in zaungast/tools —
// the lib-layer unit tests are in packages/libzaungast/test/core.unit.ts.
import { test, expect } from 'vitest';
import { parseTime, fmtTs } from 'zaungast/tools.js';

test('parseTime future/past relatives', () => {
  const now = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00:00Z, fixed
  const ctx = { tz: 'UTC', now }; // relative offsets resolve against ctx.now
  expect(parseTime('+7d', ctx)).toBe(now + 7 * 864e5);
  expect(parseTime('-7d', ctx)).toBe(now - 7 * 864e5);
  expect(parseTime('+24h', ctx)).toBe(now + 24 * 36e5);
  expect(parseTime('-24h', ctx)).toBe(now - 24 * 36e5);
  expect(parseTime('+30m', ctx)).toBe(now + 30 * 6e4);
  expect(parseTime('2026-07-01')).toBe(Date.parse('2026-07-01')); // date-only → UTC (spec)
  expect(parseTime(12345)).toBe(12345);
  expect(parseTime('not-a-date')).toBeUndefined();
});

// Non-UTC coverage for the Intl-based render helpers — the golden pins UTC (where the zone math is a
// no-op), so these exercise the paths that actually branch: offset-less datetimes resolved in a zone,
// fractional offsets, fractional seconds, and year-elision.
const NOW = Date.UTC(2026, 6, 15, 12, 0, 0); // year 2026

test('parseTime resolves offset-less ISO date-times in ctx.tz', () => {
  // Same wall time, two zones → two instants.
  expect(parseTime('2026-07-01T09:00', { tz: 'UTC', now: NOW })).toBe(Date.UTC(2026, 6, 1, 9, 0));
  // Europe/Berlin is CEST (+2) on 2026-07-01, so 09:00 local == 07:00Z.
  expect(parseTime('2026-07-01T09:00', { tz: 'Europe/Berlin', now: NOW })).toBe(
    Date.UTC(2026, 6, 1, 7, 0),
  );
  // Fractional seconds are honored (previously slipped to ambient-local Date.parse).
  expect(parseTime('2026-07-01T09:00:00.250', { tz: 'UTC', now: NOW })).toBe(
    Date.UTC(2026, 6, 1, 9, 0, 0, 250),
  );
});

test('fmtTs renders in ctx.tz with year-elision against ctx.now', () => {
  // Asia/Kolkata is +5:30 (fractional offset): 00:00Z → 05:30 local, same day.
  expect(fmtTs(Date.UTC(2026, 6, 1, 0, 0), { tz: 'Asia/Kolkata', now: NOW })).toBe('07-01 05:30');
  // Same year as ctx.now → no year prefix; different year → year prefix.
  expect(fmtTs(Date.UTC(2026, 6, 1, 9, 0), { tz: 'UTC', now: NOW })).toBe('07-01 09:00');
  expect(fmtTs(Date.UTC(2025, 0, 1, 0, 0), { tz: 'UTC', now: NOW })).toBe('2025-01-01 00:00');
});
