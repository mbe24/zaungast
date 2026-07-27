// Set the release version across the monorepo in lockstep, and re-pin internal deps — the one command
// npm workspaces don't give you (npm has no `workspace:` protocol, so an internal dep whose range stops
// matching the workspace version makes npm SILENTLY fetch a registry copy instead of linking the sibling —
// which then breaks typecheck with two copies of the package. Keeping every internal range == `^<version>`
// avoids that). Run `npm install` afterwards to sync the lockfile.
//
//   npm run version:set -- 0.5.0
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
  console.error('usage: npm run version:set -- <x.y.z[-prerelease]>');
  process.exit(2);
}

// PUBLISHED packages (+ the private root) get their `version` bumped — the release gate checks these.
const VERSION_FILES = ['package.json', 'packages/libzaungast/package.json', 'packages/zaungast/package.json'];
// EVERY workspace that depends on an internal package must be re-pinned to the new version — including
// libzaungast-native, which isn't published but still needs the workspace link at build/typecheck time.
const DEP_FILES = [...VERSION_FILES, 'packages/libzaungast-native/package.json'];
const INTERNAL = ['libzaungast']; // sibling packages referenced by other workspaces
const DEP_SCOPES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

for (const rel of DEP_FILES) {
  const path = `${REPO}${rel}`;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const bumped = VERSION_FILES.includes(rel);
  if (bumped) pkg.version = version;
  const repinned = [];
  for (const scope of DEP_SCOPES) {
    if (!pkg[scope]) continue;
    for (const dep of INTERNAL) {
      if (pkg[scope][dep]) {
        pkg[scope][dep] = `^${version}`;
        repinned.push(dep);
      }
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  const notes = [bumped ? `v${version}` : 'dep-only', ...repinned.map((d) => `${d}→^${version}`)];
  console.log(`  ${pkg.name.padEnd(20)} ${notes.join('  ')}`);
}
console.log(`\nset version ${version}. now run: npm install   (to sync package-lock.json)`);
