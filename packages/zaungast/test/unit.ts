// MCP-layer unit tests. parseTime (ISO / relative time-filter parsing) lives in zaungast/tools —
// the lib-layer unit tests are in packages/libzaungast/test/unit.ts.
import { parseTime } from 'zaungast/tools.js';

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};
const eq = (n: string, a: unknown, b: unknown) =>
  ok(
    n,
    JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`,
  );

console.log('=== parseTime future/past relatives ===');
{
  const now = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00:00Z, fixed
  eq('+7d is 7 days in the future', parseTime('+7d', now), now + 7 * 864e5);
  eq('-7d is 7 days in the past', parseTime('-7d', now), now - 7 * 864e5);
  eq('+24h is 24 hours in the future', parseTime('+24h', now), now + 24 * 36e5);
  eq('-24h is 24 hours in the past', parseTime('-24h', now), now - 24 * 36e5);
  eq('+30m is 30 minutes in the future', parseTime('+30m', now), now + 30 * 6e4);
  ok('ISO date still parses', parseTime('2026-07-01') === Date.parse('2026-07-01'));
  ok('bare epoch number still parses', parseTime(12345) === 12345);
  ok('garbage is undefined', parseTime('not-a-date') === undefined);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
