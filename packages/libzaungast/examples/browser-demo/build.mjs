// Build the browser demo into browser-demo/dist/ (build the library first:
// `npm run build --workspace libzaungast`). Emits the hosted shape — index.html + main.js + worker.js +
// sqlite3.wasm — which must be served over http (Workers, module loading, and the wasm fetch don't work
// from file://). The build runs in a Web Worker, so the UI stays responsive and shows live per-file +
// per-phase progress. Serve with any static host: `npx serve browser-demo/dist`, VS Code Live Server,
// GitHub Pages, …
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const dist = `${here}dist`;
// Typecheck first — esbuild only transpiles (no type errors), so without this a missing method or bad
// shape ships silently into the browser. tsconfig.json uses DOM libs + bundler resolution for these files.
console.log('› typechecking (tsc -p tsconfig.json)…');
execFileSync('npx', ['tsc', '-p', `${here}tsconfig.json`], { stdio: 'inherit', shell: true });
// Resolve the wasm via the package's exports map (location-independent, hoisting-independent).
const wasm = require.resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
// DuckDB-Wasm self-hosted assets (the engine picker's second backend): the wasm modules + their workers
// live in @duckdb/duckdb-wasm/dist. Its exports map only exposes '.', so resolve the package's dist dir
// off the main entry and copy the assets by name (duckdb-wasm-driver.ts loads them relative to worker.js).
const duckdbDist = path.dirname(require.resolve('@duckdb/duckdb-wasm'));
const duckdbAssets = [
  'duckdb-eh.wasm',
  'duckdb-mvp.wasm',
  'duckdb-browser-eh.worker.js',
  'duckdb-browser-mvp.worker.js',
];
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  // parse.worker.ts is a nested worker (the coordinator worker.ts spawns a pool of them for parallel
  // mode) — a separate entry so esbuild emits parse.worker.js that `new Worker(new URL(...))` can load.
  entryPoints: [`${here}main.ts`, `${here}worker.ts`, `${here}parse.worker.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: dist,
  logLevel: 'info',
});
copyFileSync(wasm, `${dist}/sqlite3.wasm`);
for (const a of duckdbAssets) copyFileSync(path.join(duckdbDist, a), `${dist}/${a}`);
copyFileSync(`${here}index.html`, `${dist}/index.html`);
copyFileSync(`${here}styles.css`, `${dist}/styles.css`);

console.log(
  '\n✓ built browser-demo/dist: index.html + styles.css + main.js + worker.js + sqlite3.wasm' +
    '  (serve over http — e.g. `npx serve browser-demo/dist`)',
);
