// Public-surface guard (data-free, CI). T4 split the package into a narrow CLIENT API ('.') and an
// engine-author SPI ('libzaungast/engine-spi'), with everything else INTERNAL (unreachable through the
// package exports map). This test pins the boundary so it can't silently drift:
//   1. '.' runtime exports are EXACTLY the client surface — no engine/ingest internals leaked in.
//   2. 'libzaungast/engine-spi' exposes EXACTLY the engine-author value set (openStoreFile + the
//      ingest inputs + the conformance constant); ChatStore/createJsEngine never appear.
//   3. Internal deep-imports (ingest/store.js, ingest/ingest.js, query.js) REJECT — proving ChatStore
//      stayed internal (the whole reason openStoreFile exists) and that ingest.ts is reachable ONLY as
//      openStoreFile via engine-spi, never as ingest()/applyIncremental.
//   4. TYPE-level guards (checked by typecheck:test, erased at runtime): the removed `Engine` policy
//      type must not reappear on '.', and engine-spi must keep exporting the four contract types.
//   5. Purity: libzaungast must not depend on the native accelerator (one-way dependency).
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/libzaungast/test/export-surface.ts
import { readFileSync } from 'node:fs';
import type * as ClientApi from 'libzaungast';
import type * as EngineSpi from 'libzaungast/engine-spi';

// (4) Type-level negative guard: `Engine` was removed from the client API in the pure cutover. If it
// were re-exported, `ClientApi.Engine` would resolve and the @ts-expect-error would itself error.
// @ts-expect-error - `Engine` must NOT be part of the client API surface '.'
export type _NoEngineOnClientApi = ClientApi.Engine;
// (4) Type-level positive guard: engine-spi must keep exporting the four engine-author contract types
// (any drop breaks this alias at typecheck:test time).
export type _SpiContractTypes = [
  EngineSpi.IngestEngine,
  EngineSpi.RefreshResult,
  EngineSpi.Ingested,
  EngineSpi.StoreMeta,
];

let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const keys = (m: object): string[] => Object.keys(m).sort();
const same = (got: string[], want: string[]): boolean =>
  got.length === want.length && got.every((k, i) => k === want[i]);

console.log('\n=== public-surface guard ===');

// 1. Client API '.' — runtime VALUE exports only (type-only exports erase). This is the frozen
// baseline: adding a runtime export to the root must be a deliberate edit to this list.
const CLIENT_API = ['htmlToText', 'inspect', 'openLiveStore', 'openStore', 'tryOpen'];
const root = keys(await import('libzaungast'));
ok(
  `'.' exposes exactly the client API [${CLIENT_API.join(', ')}]`,
  same(root, CLIENT_API),
  `got [${root.join(', ')}]`,
);
for (const leaked of [
  'openStoreFile',
  'SCHEMA_SQL',
  'EXPECTED_CONFORMANCE',
  'createJsEngine',
  'ingest',
]) {
  ok(`'.' does NOT leak ${leaked}`, !root.includes(leaked));
}

// 2. Engine SPI — EXACTLY the engine-author value set (the four contract TYPES erase at runtime).
const ENGINE_SPI = [
  'EXPECTED_CONFORMANCE',
  'SCHEMA_SQL',
  'loadBundledMappingTexts',
  'openStoreFile',
];
const spi = keys(await import('libzaungast/engine-spi'));
ok(
  `'engine-spi' exposes exactly [${ENGINE_SPI.join(', ')}]`,
  same(spi, ENGINE_SPI),
  `got [${spi.join(', ')}]`,
);
for (const hidden of ['ChatStore', 'createJsEngine', 'ingest']) {
  ok(`'engine-spi' does NOT expose ${hidden}`, !spi.includes(hidden));
}

// 3. Internal deep-imports must REJECT (not in the exports map). store.js + query.js keep ChatStore
// and the SQL layer internal; ingest.js is the sensitive one — both ingest() and openStoreFile live
// there, and only the latter may be reached, via engine-spi (never ingest()/applyIncremental raw).
for (const internal of [
  'libzaungast/ingest/store.js',
  'libzaungast/ingest/ingest.js',
  'libzaungast/query.js',
]) {
  let rejected = false;
  let detail = '(resolved — LEAK)';
  try {
    await import(internal);
  } catch (e) {
    const code = (e as { code?: string }).code ?? '';
    const msg = (e as Error).message ?? '';
    rejected =
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || /not exported|package subpath/i.test(msg);
    detail = `code=${code}`;
  }
  ok(`internal '${internal}' is not importable`, rejected, detail);
}

// 5. Purity / one-way dependency: libzaungast must never depend on the native accelerator. The
// dependency only ever points the other way (libzaungast-native → libzaungast/engine-spi).
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};
const allDeps = {
  ...manifest.dependencies,
  ...manifest.peerDependencies,
  ...manifest.optionalDependencies,
};
ok(
  'libzaungast does NOT depend on libzaungast-native (one-way dependency)',
  !('libzaungast-native' in allDeps),
  `deps=[${Object.keys(allDeps).join(', ')}]`,
);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
