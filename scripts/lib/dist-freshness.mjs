// scripts/lib/dist-freshness.mjs — freshness guard shared by the TS profiler (scripts/profile.mjs) and
// the byte-differential harness (scripts/native-diff.mjs). BOTH run the library from its BUILT `dist/`,
// so an un-rebuilt `dist` silently measures (profiler) or validates (differential — worse, it's the
// correctness gate) STALE code against the current `src`. This compares the newest mtime under each
// package's `src` to the newest under its `dist` and hard-fails when `src` is newer.
//
// Accepted limits (a content-hash manifest would remove them, but that is more machinery than a footgun
// guard warrants): `git checkout` bumps `src` mtimes with no content change (a false "stale" — just
// rebuild), and a DELETED `src` file leaves an orphan output in `dist` that mtimes cannot see. Both fail
// safe: the guard errs toward telling you to rebuild, never toward blessing stale output.
import fs from 'node:fs';
import path from 'node:path';

// Newest mtimeMs among all files under `dir` (recursive). Returns 0 if the dir is absent/empty — for a
// dist dir that reads as "never built", which the caller treats as stale.
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return; // missing dir → contributes nothing
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const m = fs.statSync(p).mtimeMs;
        if (m > newest) newest = m;
      }
    }
  };
  walk(dir);
  return newest;
}

// `packages`: [{ label, srcDir, distDir }]. Returns the stale ones (never-built or src-newer-than-dist).
export function checkDistFreshness(packages) {
  return packages.filter(({ srcDir, distDir }) => {
    const dist = newestMtime(distDir);
    return dist === 0 || newestMtime(srcDir) > dist; // never built, or edited since the last build
  });
}

// Hard-fail with a rebuild instruction if any package's dist is stale. Call before doing real work.
export function assertDistFresh(packages) {
  const stale = checkDistFreshness(packages);
  if (stale.length === 0) return;
  console.error(
    `\n✗ dist is stale for: ${stale.map((p) => p.label).join(', ')}\n` +
      `  Source has changed since the last build — this run would use OLD compiled code.\n` +
      `  Rebuild first:  npm run build\n`,
  );
  process.exit(1);
}

// Newest dist mtime across `distDirs`, as an ISO string (or null if none built). The TS profiler stamps
// this into its timings envelope so a stale run stays auditable after the fact (the git SHA cannot show
// it — dist is gitignored, so even a clean tree can carry a stale dist).
export function distBuiltAt(distDirs) {
  const newest = Math.max(0, ...distDirs.map(newestMtime));
  return newest ? new Date(newest).toISOString() : null;
}
