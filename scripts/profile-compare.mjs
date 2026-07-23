// scripts/profile-compare.mjs — diff two v1 timings.json runs (scripts/lib/timings-v1.mjs). The mode
// is inferred from the `engine` field, so one invocation covers all three cases:
//   engines DIFFER (ts vs native) → PARITY: compare the shared canonical `metrics`; keys unique to one
//                                   engine (e.g. refresh.noop.copyReuse vs fileRefresh) are listed, not
//                                   diffed. `engineExtra` is engine-specific → shown only with --all.
//   engines MATCH  (ts vs ts, or native vs native) → REGRESSION: former→current over metrics ∪
//                                   engineExtra (same engine ⇒ all keys comparable); each drift flagged.
//
// Gates (hard error): same dataset (fingerprint AND entries AND bytes), same unit per shared key, and
// same host.platform — the last one keeps both honest (parity needs both engines on ONE platform, e.g.
// WSL2; regression needs the two runs on the same machine). --allow-cross-runner downgrades the
// platform check to a warning. Output is measurements + flags only — no prose verdict.
//
//   node scripts/profile-compare.mjs <former.json> <current.json>
//        [--all] [--allow-cross-runner] [--pct N] [--abs-ms N]
import fs from 'node:fs';
import { SCHEMA_VERSION } from './lib/timings-v1.mjs';

const args = process.argv.slice(2);
const flags = new Set();
let pctThresh = 10; // regression flag: |Δ%| must exceed this …
let absMs = 2; //                      … AND (for ms metrics) |Δ| must exceed this
const positionals = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--all' || a === '--allow-cross-runner') flags.add(a);
  else if (a === '--pct') pctThresh = Number(args[++i]);
  else if (a === '--abs-ms') absMs = Number(args[++i]);
  else positionals.push(a);
}
const [leftPath, rightPath] = positionals;
if (!leftPath || !rightPath) {
  console.error(
    'usage: node scripts/profile-compare.mjs <former.json> <current.json> [--all] [--allow-cross-runner] [--pct N] [--abs-ms N]',
  );
  process.exit(2);
}

const die = (m) => {
  console.error(`error: ${m}`);
  process.exit(1);
};
if (Number.isNaN(pctThresh) || Number.isNaN(absMs)) die('--pct and --abs-ms each require a number');
const load = (p) => {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (j.schemaVersion !== SCHEMA_VERSION)
    die(`${p}: schemaVersion ${j.schemaVersion} != ${SCHEMA_VERSION}`);
  return j;
};
const L = load(leftPath);
const R = load(rightPath);

// ---- gates ----
for (const k of ['fingerprint', 'entries', 'bytes']) {
  if (L.dataset[k] !== R.dataset[k]) {
    die(
      `dataset.${k} differs (${L.dataset[k]} vs ${R.dataset[k]}) — not the same capture, so a diff is meaningless`,
    );
  }
}
if (L.host.platform !== R.host.platform) {
  if (flags.has('--allow-cross-runner')) {
    console.error(
      `WARNING: cross-runner (${L.host.platform} vs ${R.host.platform}) — I/O-bound timings are NOT comparable; proceeding per --allow-cross-runner`,
    );
  } else {
    die(
      `host.platform differs (${L.host.platform} vs ${R.host.platform}) — both runs must be on the same platform (e.g. both WSL2). Override with --allow-cross-runner.`,
    );
  }
}

const parity = L.engine !== R.engine;
// the representative number of a metric: its single value (n=1) or its p50.
const repr = (m) => (m == null ? null : m.n === 1 ? m.value : m.p50);
const isMetric = (v) => v != null && typeof v === 'object' && 'unit' in v;
// unit-bearing metrics only (engineExtra also holds bare counts like dbSizeBytes — skip those).
const metricsOf = (j, includeExtra) => {
  const out = {};
  const srcs = includeExtra ? [j.metrics, j.engineExtra] : [j.metrics];
  for (const src of srcs)
    for (const [k, v] of Object.entries(src ?? {})) if (isMetric(v)) out[k] = v;
  return out;
};
const num = (x) => (x == null ? '—' : String(+x.toFixed(3)));
const signed = (x) => (x >= 0 ? '+' : '') + +x.toFixed(3);
const sha = (j) => `${(j.git?.sha || '???').slice(0, 7)}${j.git?.dirty ? '+' : ''}`;
// TS runs stamp the dist they loaded (see timings-v1 envelope). Surfacing it makes a stale-dist run
// visible in a comparison — the SHA alone can't, since dist is gitignored. Absent on native/older runs.
const built = (j) => (j.distBuiltAt ? ` dist@${j.distBuiltAt}` : '');
// Cross-engine, these two aren't commit-for-commit comparable (native wraps apply+recompute+fts in one
// txn with the COMMIT in `fts`; TS commits per-phase) — flag them in the PARITY table only. Within a
// same-engine regression they ARE comparable, so no mark there.
const APPROX = new Set(['storeBuild.apply', 'storeBuild.fts']);
const mark = (k, approx) => (approx && APPROX.has(k) ? `${k} ~` : k);

console.log(`mode: ${parity ? 'PARITY (cross-engine)' : 'REGRESSION (same-engine)'}`);
console.log(
  `  former:  ${L.engine.padEnd(7)} [${sha(L)}] ${L.when} ${L.host.platform}${built(L)}  (${leftPath})`,
);
console.log(
  `  current: ${R.engine.padEnd(7)} [${sha(R)}] ${R.when} ${R.host.platform}${built(R)}  (${rightPath})`,
);
console.log(
  `  dataset: fp ${L.dataset.fingerprint} · ${L.dataset.entries} entries · ${(L.dataset.bytes / 1048576).toFixed(1)} MB`,
);

if (parity) {
  // ---- PARITY: shared canonical metrics only ----
  const lm = metricsOf(L, flags.has('--all'));
  const rm = metricsOf(R, flags.has('--all'));
  const shared = Object.keys(lm)
    .filter((k) => k in rm)
    .sort();
  console.log(
    `\n  ${'metric'.padEnd(30)} ${L.engine.padStart(12)} ${R.engine.padStart(12)}  ${'ratio'.padStart(7)}  ${'n'.padStart(7)}  unit`,
  );
  for (const k of shared) {
    const [a, b] = [lm[k], rm[k]];
    if (a.unit !== b.unit) die(`unit mismatch for ${k}: ${a.unit} vs ${b.unit}`);
    const [av, bv] = [repr(a), repr(b)];
    const ratio = av ? `${(bv / av).toFixed(2)}×` : '—';
    console.log(
      `  ${mark(k, true).padEnd(30)} ${num(av).padStart(12)} ${num(bv).padStart(12)} ${ratio.padStart(8)}  ${`${a.n}/${b.n}`.padStart(7)}  ${a.unit}`,
    );
  }
  if (shared.some((k) => APPROX.has(k)))
    console.log(
      '\n  ~ apply/fts: not commit-for-commit comparable cross-engine (differing transaction boundaries)',
    );
  const only = (m, other, eng) => {
    const ks = Object.keys(m)
      .filter((k) => !(k in other))
      .sort();
    if (ks.length) console.log(`\n  only in ${eng}: ${ks.join(', ')}`);
  };
  only(lm, rm, L.engine);
  only(rm, lm, R.engine);
  process.exit(0);
}

// ---- REGRESSION: former → current over metrics ∪ engineExtra (same engine ⇒ all comparable) ----
const lm = metricsOf(L, true);
const rm = metricsOf(R, true);
const shared = Object.keys(lm)
  .filter((k) => k in rm)
  .sort();
const higherIsBetter = (u) => u === 'perSec' || u === 'MBperSec';
console.log(
  `\n  ${'metric'.padEnd(28)} ${'former'.padStart(11)} ${'current'.padStart(11)} ${'Δ'.padStart(11)} ${'Δ%'.padStart(8)}  ${'n'.padStart(7)}  flag`,
);
let regressions = 0;
for (const k of shared) {
  const [a, b] = [lm[k], rm[k]];
  if (a.unit !== b.unit) die(`unit mismatch for ${k}: ${a.unit} vs ${b.unit}`);
  const [av, bv] = [repr(a), repr(b)];
  const d = bv - av;
  const pct = av ? (d / av) * 100 : 0;
  // former=0 can't yield a %, but a 0→nonzero move is still a real change worth flagging.
  const significant =
    av === 0
      ? bv !== 0
      : Math.abs(pct) > pctThresh && (a.unit === 'ms' ? Math.abs(d) > absMs : true);
  const worse = higherIsBetter(a.unit) ? d < 0 : d > 0;
  let flag = '—';
  if (significant) {
    flag = worse ? '⚠ regressed' : '✓ improved';
    if (worse) regressions++;
  }
  console.log(
    `  ${k.padEnd(28)} ${num(av).padStart(11)} ${num(bv).padStart(11)} ${signed(d).padStart(11)} ${(av ? pct.toFixed(1) : '—').padStart(7)}%  ${`${a.n}/${b.n}`.padStart(7)}  ${flag}`,
  );
}
const only = (m, other, which) => {
  const ks = Object.keys(m)
    .filter((k) => !(k in other))
    .sort();
  if (ks.length) console.log(`\n  only in ${which}: ${ks.join(', ')}`);
};
only(lm, rm, 'former');
only(rm, lm, 'current');
console.log(
  `\n  ${regressions} metric(s) flagged as regressed (threshold: |Δ%| > ${pctThresh}% and |Δ| > ${absMs}ms for ms).`,
);
process.exit(regressions > 0 ? 1 : 0);
