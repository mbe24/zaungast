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

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = `${here}dist`;
// Resolve the wasm via the package's exports map (location-independent, hoisting-independent).
const wasm = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

await esbuild.build({
  entryPoints: [`${here}main.ts`, `${here}worker.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outdir: dist,
  logLevel: 'info',
});
copyFileSync(wasm, `${dist}/sqlite3.wasm`);
copyFileSync(`${here}index.html`, `${dist}/index.html`);

console.log(
  '\n✓ built browser-demo/dist: index.html + main.js + worker.js + sqlite3.wasm' +
    '  (serve over http — e.g. `npx serve browser-demo/dist`)',
);
