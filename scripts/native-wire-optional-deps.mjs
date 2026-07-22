// Wire the native main package's `optionalDependencies` from the per-platform stubs that napi
// generated (`napi create-npm-dir`) and filled with a prebuilt (`napi artifacts`). Run from the
// libzaungast-native package dir, in CI only, AFTER those two napi steps — the result is never
// committed; it exists just long enough to publish.
//
// Why this instead of `napi prepublish`: prepublish would (a) publish without --provenance / without
// an idempotent skip, and (b) declare an optionalDependency for EVERY napi.triple — including
// x86_64-apple-darwin, which we don't ship — leaving a permanently-unresolvable optional dep. Here we
// wire ONLY the platforms that actually received a binary, and drop the rest.
//
// Contract (fail-loud, no partial releases):
//   - every npm/<platform>/ dir that HAS a .node  → version-locked to the main package + wired in.
//   - every npm/<platform>/ dir that has NO .node  → dropped (the intentionally-unshipped Intel-mac
//     stub; it stays in napi.triples for local Intel-Mac builds but ships nothing).
//   - the count of wired platforms MUST equal EXPECTED_PREBUILTS (the number of release build legs),
//     so a build leg whose artifact went missing fails the release instead of shipping a main package
//     that points at a platform package we never published.
import fs from 'node:fs';
import path from 'node:path';

const expected = Number(process.env.EXPECTED_PREBUILTS);
if (!Number.isInteger(expected) || expected <= 0) {
  console.error(
    `FAIL wire-optional-deps: EXPECTED_PREBUILTS must be a positive integer, got '${process.env.EXPECTED_PREBUILTS}'.`,
  );
  process.exit(1);
}

const main = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const npmDir = 'npm';
if (!fs.existsSync(npmDir)) {
  console.error(
    `FAIL wire-optional-deps: no ${npmDir}/ dir — run \`napi create-npm-dir\` + \`napi artifacts\` first.`,
  );
  process.exit(1);
}

const dirs = fs
  .readdirSync(npmDir)
  .filter((d) => fs.statSync(path.join(npmDir, d)).isDirectory())
  .sort();

const optionalDependencies = {};
for (const d of dirs) {
  const full = path.join(npmDir, d);
  const hasNode = fs.readdirSync(full).some((f) => f.endsWith('.node'));
  const stub = JSON.parse(fs.readFileSync(path.join(full, 'package.json'), 'utf8'));
  if (hasNode) {
    // Lockstep: the platform package ships at the same version as the main package.
    stub.version = main.version;
    fs.writeFileSync(path.join(full, 'package.json'), `${JSON.stringify(stub, null, 2)}\n`);
    optionalDependencies[stub.name] = main.version;
    console.log(`wired ${stub.name}@${main.version} (${d})`);
  } else {
    fs.rmSync(full, { recursive: true, force: true });
    console.log(`dropped unshipped platform stub ${stub.name} (${d}) — no prebuilt`);
  }
}

const names = Object.keys(optionalDependencies);
if (names.length !== expected) {
  console.error(
    `FAIL wire-optional-deps: wired ${names.length} platform packages but EXPECTED_PREBUILTS=${expected} — a build leg's prebuilt is missing.\n` +
      `  wired: [${names.join(', ')}]`,
  );
  process.exit(1);
}

main.optionalDependencies = Object.fromEntries(Object.entries(optionalDependencies).sort());
fs.writeFileSync('package.json', `${JSON.stringify(main, null, 2)}\n`);
console.log(
  `PASS wire-optional-deps: ${names.length} platform packages wired into optionalDependencies.`,
);
