// Public-surface guard (data-free, CI). The package is split into a narrow CLIENT API ('.') and an
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
import { test, expect } from 'vitest';
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

const keys = (m: object): string[] => Object.keys(m).sort();

// 1. Client API '.' — runtime VALUE exports only (type-only exports erase). This is the frozen
// baseline: adding a runtime export to the root must be a deliberate edit to this list.
const CLIENT_API = ['htmlToText', 'inspect', 'openLiveStore', 'openStore', 'tryOpen'];

test("'.' exposes exactly the client API", async () => {
  const root = keys(await import('libzaungast'));
  expect(root).toEqual(CLIENT_API);
});

test.each(['openStoreFile', 'SCHEMA_SQL', 'EXPECTED_CONFORMANCE', 'createJsEngine', 'ingest'])(
  "'.' does NOT leak %s",
  async (leaked) => {
    const root = keys(await import('libzaungast'));
    expect(root).not.toContain(leaked);
  },
);

// 2. Engine SPI — EXACTLY the engine-author value set (the four contract TYPES erase at runtime).
const ENGINE_SPI = [
  'EXPECTED_CONFORMANCE',
  'SCHEMA_SQL',
  'loadBundledMappingTexts',
  'openStoreFile',
];

test("'engine-spi' exposes exactly the engine-author value set", async () => {
  const spi = keys(await import('libzaungast/engine-spi'));
  expect(spi).toEqual(ENGINE_SPI);
});

test.each(['ChatStore', 'createJsEngine', 'ingest'])(
  "'engine-spi' does NOT expose %s",
  async (hidden) => {
    const spi = keys(await import('libzaungast/engine-spi'));
    expect(spi).not.toContain(hidden);
  },
);

// 3. Internal deep-imports must REJECT (not in the exports map). store.js + query.js keep ChatStore
// and the SQL layer internal; ingest.js is the sensitive one — both ingest() and openStoreFile live
// there, and only the latter may be reached, via engine-spi (never ingest()/applyIncremental raw).
test.each(['libzaungast/ingest/store.js', 'libzaungast/ingest/ingest.js', 'libzaungast/query.js'])(
  'internal %s is not importable',
  async (internal) => {
    let resolved = false;
    let code = '';
    let msg = '';
    try {
      await import(/* @vite-ignore */ internal);
      resolved = true;
    } catch (e) {
      code = (e as { code?: string }).code ?? '';
      msg = (e as Error).message ?? '';
    }
    expect(resolved, `${internal} resolved — LEAK`).toBe(false);
    expect(
      code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || /not exported|package subpath/i.test(msg),
      `unexpected rejection: code=${code} msg=${msg}`,
    ).toBe(true);
  },
);

// 5. Purity / one-way dependency: libzaungast must never depend on the native accelerator. The
// dependency only ever points the other way (libzaungast-native → libzaungast/engine-spi).
test('libzaungast does NOT depend on libzaungast-native (one-way dependency)', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
  };
  const allDeps = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  expect(Object.keys(allDeps)).not.toContain('libzaungast-native');
});
