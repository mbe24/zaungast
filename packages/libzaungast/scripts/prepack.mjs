// prepack: strip the in-repo `development` export/import conditions from the PUBLISHED package.json.
// They point at ./src (for tsc customConditions + the demo/POC dev servers, so edits hot-reload), but
// `files:["dist"]` ships only ./dist — and Vite dev / webpack `mode:development` auto-activate the
// `development` condition, so a published consumer's DEV server would resolve to a missing ./src.
// The original is backed up and restored by scripts/postpack.mjs after packing.
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const PKG = new URL('../package.json', import.meta.url);
const BAK = new URL('../package.json.prepack-bak', import.meta.url);

copyFileSync(PKG, BAK);
const pkg = JSON.parse(readFileSync(PKG, 'utf8'));

// Recursively delete every `development` condition key (top-level in each ./web/… export entry, and
// nested under #bytes.browser in imports). Strings/arrays are left alone.
const strip = (o) => {
  if (!o || typeof o !== 'object') return;
  delete o.development;
  for (const v of Object.values(o)) strip(v);
};
strip(pkg.exports);
strip(pkg.imports);

writeFileSync(PKG, JSON.stringify(pkg, null, 2) + '\n');
console.log('prepack: stripped `development` conditions from package.json for publish');
