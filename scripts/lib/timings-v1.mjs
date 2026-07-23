// scripts/lib/timings-v1.mjs — the SINGLE definition of the v1 profiling schema, shared by the TS
// profiler (profile.mjs) and the compare tool (profile-compare.mjs). The native profiler (profile.rs)
// re-implements the SAME shape in Rust; this file is the human-readable spec of record.
//
// A run is an envelope:
//   { schemaVersion, engine, when, git, host, runtime, dataset, mode, iters, metrics, engineExtra }
// `metrics` maps a CANONICAL metric name → a measurement. Two engines are comparable iff they emit the
// same metric name with the same `unit`. Anything one engine can't express goes in `engineExtra`.
//
// Stats are RAW (full precision) here — the consumer (console / compare tool) rounds for display. The
// percentile + stddev DEFINITIONS below are the contract the native side must match; a shared test
// vector will pin them (added alongside the compare tool) so the two implementations can't drift.
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export const SCHEMA_VERSION = 1;

// A sampled measurement over n≥1 timings. Percentile = nearest-rank (ceil, clamped); stddev =
// population (÷n). At n=1 every percentile collapses to the single value, so scalars need no special
// case — but `scalar()` is provided for readability where only one value was ever taken.
export function metric(unit, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) throw new Error('metric(): empty sample set');
  if (n === 1) return { unit, n: 1, value: s[0] }; // same shape as scalar() — the n===1 discriminator
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const variance = s.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const pc = (q) => s[Math.min(n - 1, Math.max(0, Math.ceil(n * q) - 1))];
  return {
    unit,
    n,
    min: s[0],
    p50: pc(0.5),
    p75: pc(0.75),
    p90: pc(0.9),
    p95: pc(0.95),
    p99: pc(0.99),
    max: s[n - 1],
    mean,
    stddev: Math.sqrt(variance),
  };
}

// A single-value measurement. `n:1` is the discriminator: consumers (console, compare tool) read
// `.value` when `n === 1` and the percentile fields otherwise — no need to fill p50/p90/… with copies.
export const scalar = (unit, value) => ({ unit, n: 1, value });

// Run provenance — REQUIRED for baselines: a "regressed +12%" diff is meaningless without the SHA +
// host the baseline was taken on, and the compare tool refuses a cross-`host.platform` parity run.
export function provenance() {
  const git = (args) => spawnSync('git', args, { encoding: 'utf8' }).stdout?.trim() ?? '';
  return {
    when: new Date().toISOString(),
    git: { sha: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 },
    host: { platform: os.platform(), cpu: os.cpus()[0]?.model ?? '', hostname: os.hostname() },
    runtime: `node ${process.version}`,
  };
}

// Assemble the envelope. `metrics`/`engineExtra` are plain { name: metric } maps. `distBuiltAt` is an
// optional ISO timestamp of the dist the run loaded (TS profiler only — native has no dist; omitted when
// null so the shape is unchanged for engines that don't pass it).
export function envelope({
  engine,
  dataset,
  mode,
  iters,
  metrics,
  engineExtra = {},
  distBuiltAt = null,
}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    engine,
    ...provenance(),
    ...(distBuiltAt ? { distBuiltAt } : {}),
    dataset,
    mode,
    iters,
    metrics,
    engineExtra,
  };
}
