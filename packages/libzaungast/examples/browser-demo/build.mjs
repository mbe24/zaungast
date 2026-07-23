// Build the POC into poc/dist/ in TWO shapes (needs the library built first:
// `npm run build --workspace libzaungast`):
//
//   1. Hosted (live progress, needs http): index.html + main.js + worker.js + sqlite3.wasm — clean
//      separate files. The build runs in a Web Worker (responsive UI, live per-file + phase progress).
//      Serve with any static host: `node poc/serve.mjs`, VS Code Live Server, GitHub Pages, …
//   2. Standalone (double-click, file://): a single self-contained standalone.html with the JS + wasm
//      inlined and no Worker (tab freezes ~5s during the build; phase timings shown at the end).
import esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = `${here}dist`;
// Resolve the wasm via the package's exports map (location-independent, hoisting-independent).
const wasm = createRequire(import.meta.url).resolve('@sqlite.org/sqlite-wasm/sqlite3.wasm');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1. Hosted: separate files (Worker), wasm served alongside + streamed.
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

// 2. Standalone: one file, JS + wasm (base64) inlined into an inline module script.
const standalone = await esbuild.build({
  entryPoints: [`${here}standalone.ts`],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  loader: { '.wasm': 'base64' },
  write: false,
  logLevel: 'info',
});
const js = standalone.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(`${here}standalone.html`, 'utf8').replace(
  '<!--BUNDLE-->',
  `<script type="module">\n${js}\n</script>`,
);
writeFileSync(`${dist}/standalone.html`, html);

const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(
  `\n✓ built browser-demo/dist:\n` +
    `  • hosted     → index.html + main.js + worker.js + sqlite3.wasm  (serve over http; live progress)\n` +
    `  • standalone → standalone.html (${kb} KB, self-contained; double-click / file://; timings at end)`,
);
