// Set the release version across the monorepo in lockstep, and re-pin internal deps — the one command
// npm workspaces don't give you. Bumps the root + every PUBLISHED package to <version>, and rewrites any
// dependency on an INTERNAL package to `^<version>`. Run `npm install` afterwards to sync the lockfile.
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

// Root is private (not published) — bumped only so the monorepo reads one version.
const FILES = ['package.json', 'packages/libzaungast/package.json', 'packages/zaungast/package.json'];
const INTERNAL = ['libzaungast']; // sibling packages other workspaces depend on → re-pin to ^version
const DEP_SCOPES = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

for (const rel of FILES) {
  const path = `${REPO}${rel}`;
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = version;
  for (const scope of DEP_SCOPES) {
    if (!pkg[scope]) continue;
    for (const dep of INTERNAL) if (pkg[scope][dep]) pkg[scope][dep] = `^${version}`;
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${pkg.name} → ${version}`);
}
console.log(`\nset version ${version}. now run: npm install   (to sync package-lock.json)`);
