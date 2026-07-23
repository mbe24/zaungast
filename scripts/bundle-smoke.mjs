// A8 browser tripwire. Bundles the built `./web` entry for the browser and FAILS if esbuild can't (a
// node: builtin — or anything non-browser — is reachable) or if any bundled input is a node: builtin.
// This is what keeps the browser surface honest: reintroduce node:fs anywhere in the decode/extract
// graph and dist/web.js stops bundling, turning CI red here rather than at a user's browser. Runs after
// `npm run build` (needs dist/web.js). esbuild is a declared devDependency.
import esbuild from 'esbuild';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../packages/libzaungast/dist/web.js', import.meta.url));
if (!fs.existsSync(entry)) {
  console.error(`✗ ${entry} not found — run \`npm run build\` first.`);
  process.exit(1);
}

let result;
try {
  result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
} catch (e) {
  console.error('✗ browser bundle of ./web FAILED — a node: builtin (or other non-browser import) is reachable:\n');
  console.error(e.message ?? e);
  process.exit(1);
}

// Defence in depth: platform:'browser' already errors on node: builtins above, but assert none slipped
// in as a bundled input (e.g. via an externalized/aliased path).
const nodeInputs = Object.keys(result.metafile.inputs).filter((p) => p.startsWith('node:'));
if (nodeInputs.length) {
  console.error('✗ ./web bundle pulled node: builtins:', nodeInputs.join(', '));
  process.exit(1);
}

const bytes = result.outputFiles?.[0]?.contents.length ?? 0;
console.log(
  `✓ ./web bundles for the browser — ${Object.keys(result.metafile.inputs).length} inputs, ${(bytes / 1024).toFixed(1)}kb, no node: builtins`,
);
