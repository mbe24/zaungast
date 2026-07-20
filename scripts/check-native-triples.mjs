// Native-triples consistency guard (T5). The manual native.yml matrix builds a prebuilt .node per
// target; `napi build` + the generated CJS addon loader cover exactly package.json's napi.triples. If
// a native.yml leg isn't in napi.triples, that platform builds nothing and the generated loader has no
// branch for it — a silent coverage gap. This asserts native.yml's matrix targets ⊆ napi.triples.
// (A napi.triples superset — e.g. an extra musl target with no CI leg — is fine.)
import fs from 'node:fs';

// napi-rs v2 `defaults: true` expands to these three x86_64 host triples (stable in v2). Kept explicit
// so this check needs no napi runtime; revisit if the CLI's default set ever changes.
const NAPI_DEFAULTS = ['x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'];

const pkg = JSON.parse(fs.readFileSync('packages/libzaungast-native/package.json', 'utf8'));
const napi = pkg.napi?.triples ?? {};
const declared = new Set([...(napi.defaults ? NAPI_DEFAULTS : []), ...(napi.additional ?? [])]);

const yml = fs.readFileSync('.github/workflows/native.yml', 'utf8');
const targets = [...yml.matchAll(/^\s*-\s*target:\s*(\S+)\s*$/gm)].map((m) => m[1]);
if (!targets.length) {
  console.error('FAIL native-triples: no `target:` entries found in native.yml (regex drift?)');
  process.exit(1);
}

const missing = targets.filter((t) => !declared.has(t));
if (missing.length) {
  console.error('FAIL native-triples: native.yml matrix targets absent from napi.triples:');
  for (const t of missing) console.error(`  ${t}`);
  console.error(`  declared napi.triples: [${[...declared].join(', ')}]`);
  process.exit(1);
}
console.log(
  `PASS native-triples: all ${targets.length} native.yml targets ⊆ napi.triples [${[...declared].join(', ')}]`,
);
