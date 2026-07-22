// scripts/test-timings-v1.mjs — the TS half of the shared percentile test vector (the Rust half is
// `percentile_vector_matches_ts` in packages/libzaungast-native/src/bin/profile.rs). Both assert the
// SAME fixed sample array against the SAME expected stats, pinning the nearest-rank (ceil, clamped)
// percentile + population-stddev definitions so the two profilers' stats can't drift — which is what
// lets profile-compare.mjs treat the native `stat()` and the TS `metric()` as interchangeable.
//   node scripts/test-timings-v1.mjs   (or `npm run test:schema`)
import assert from 'node:assert/strict';
import { metric, scalar, SCHEMA_VERSION } from './lib/timings-v1.mjs';

assert.equal(SCHEMA_VERSION, 1);

const m = metric('ms', [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
assert.deepEqual(
  {
    n: m.n,
    min: m.min,
    p50: m.p50,
    p75: m.p75,
    p90: m.p90,
    p95: m.p95,
    p99: m.p99,
    max: m.max,
    mean: m.mean,
  },
  { n: 10, min: 10, p50: 50, p75: 80, p90: 90, p95: 100, p99: 100, max: 100, mean: 55 },
);
assert.ok(Math.abs(m.stddev - Math.sqrt(825)) < 1e-9, 'population stddev'); // variance = 825

// n=1 collapses to a bare `{ unit, n:1, value }` — the discriminator native mirrors.
assert.deepEqual(metric('ms', [42]), { unit: 'ms', n: 1, value: 42 });
assert.deepEqual(scalar('ms', 42), { unit: 'ms', n: 1, value: 42 });

console.log(
  'timings-v1 percentile vector OK (matches the native percentile_vector_matches_ts test)',
);
