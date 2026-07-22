// Native-triples consistency guard. Three CI surfaces name the platforms the native accelerator
// supports and this keeps them from drifting apart:
//   1. package.json napi.triples — what `napi build` + the generated CJS loader know how to build/load.
//   2. native.yml matrix          — the platforms we manually build + prove byte-equal (the full gate).
//   3. release.yml matrix         — the platforms we ship prebuilts for, plus EXPECTED_PREBUILTS (the
//                                    leg count the publish job's wiring script enforces).
//
// Asserts: native.yml matrix == release.yml matrix (we ship exactly what we verify), both ⊆
// napi.triples (every shipped/tested leg has a build target + loader branch), and EXPECTED_PREBUILTS
// equals that leg count. napi.triples MAY be a superset — e.g. x86_64-apple-darwin is declared for
// local Intel-Mac builds but shipped by neither matrix (Intel-Mac installs fall back to the JS engine).
import fs from 'node:fs';

// napi-rs v2 `defaults: true` expands to these three x86_64 host triples (stable in v2). Kept explicit
// so this check needs no napi runtime; revisit if the CLI's default set ever changes.
const NAPI_DEFAULTS = ['x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'];

const pkg = JSON.parse(fs.readFileSync('packages/libzaungast-native/package.json', 'utf8'));
const napi = pkg.napi?.triples ?? {};
const declared = new Set([...(napi.defaults ? NAPI_DEFAULTS : []), ...(napi.additional ?? [])]);

const fail = (msg) => {
  console.error(`FAIL native-triples: ${msg}`);
  process.exit(1);
};

// Pull `- target: <triple>` matrix entries out of a workflow file.
const targetsOf = (file) => {
  const yml = fs.readFileSync(file, 'utf8');
  const targets = [...yml.matchAll(/^\s*-\s*target:\s*(\S+)\s*$/gm)].map((m) => m[1]);
  if (!targets.length) fail(`no \`target:\` entries found in ${file} (regex drift?)`);
  return targets;
};

const nativeTargets = targetsOf('.github/workflows/native.yml');
const releaseTargets = targetsOf('.github/workflows/release.yml');

// Both matrices ⊆ napi.triples.
for (const [file, targets] of [
  ['native.yml', nativeTargets],
  ['release.yml', releaseTargets],
]) {
  const missing = targets.filter((t) => !declared.has(t));
  if (missing.length) {
    fail(
      `${file} matrix targets absent from napi.triples: [${missing.join(', ')}]; ` +
        `declared napi.triples: [${[...declared].join(', ')}]`,
    );
  }
}

// native.yml matrix == release.yml matrix (ship exactly what we verify).
const asSet = (a) => [...new Set(a)].sort().join(', ');
if (asSet(nativeTargets) !== asSet(releaseTargets)) {
  fail(
    `native.yml and release.yml matrices differ — we must ship exactly what we verify.\n` +
      `  native.yml:  [${asSet(nativeTargets)}]\n` +
      `  release.yml: [${asSet(releaseTargets)}]`,
  );
}

// EXPECTED_PREBUILTS (release.yml publish job) == number of shipped legs.
const releaseYml = fs.readFileSync('.github/workflows/release.yml', 'utf8');
const expMatch = releaseYml.match(/EXPECTED_PREBUILTS:\s*['"]?(\d+)['"]?/);
if (!expMatch) fail('EXPECTED_PREBUILTS not found in release.yml (regex drift?)');
const expected = Number(expMatch[1]);
const legCount = new Set(releaseTargets).size;
if (expected !== legCount)
  fail(`EXPECTED_PREBUILTS=${expected} but release.yml ships ${legCount} legs.`);

const extra = [...declared].filter((t) => !nativeTargets.includes(t));
console.log(
  `PASS native-triples: ${legCount} shipped legs [${asSet(nativeTargets)}] verified == shipped, ` +
    `⊆ napi.triples, EXPECTED_PREBUILTS=${expected}.` +
    (extra.length ? ` napi.triples-only (build-locally, unshipped): [${extra.join(', ')}].` : ''),
);
