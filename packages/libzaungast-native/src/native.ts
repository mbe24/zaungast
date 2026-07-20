// The optional native engine (seam A), packaged as its OWN module so libzaungast stays pure. It
// probes for the compiled Rust addon (via the CJS loader index.cjs), verifies a conformance
// handshake, and — when usable — has Rust read the leveldb dir and write the ChatStore .db
// end-to-end. We wrap that finished file as an `Ingested` through libzaungast's engine SPI
// (`openStoreFile`, so `ChatStore` stays internal to libzaungast). The consumer constructs the engine
// with `createNativeEngine()` and injects it into openStore / openLiveStore; libzaungast itself never
// depends on this package. Native does FULL ingest + native incremental (new-file-swap); it has no
// copy-reuse fast path, so the engine omits `reuseRefresh`.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import {
  SCHEMA_SQL,
  loadBundledMappingTexts,
  EXPECTED_CONFORMANCE,
  openStoreFile,
  type IngestEngine,
  type RefreshResult,
  type Ingested,
  type StoreMeta,
} from 'libzaungast/engine-spi';

// The compiled addon's surface (mirrors src/bindings.rs; napi maps Rust snake_case → camelCase).
interface NativeIngestResult {
  fingerprint: string;
  schemaMatched: boolean;
  mappingVersion: string | null;
  lossy: boolean;
  selfMri: string | null;
  conversations: number;
  messages: number;
  people: number;
  earliestTs: number;
  ftsEnabled: boolean;
}
interface NativeRefreshResult {
  needFullRebuild: boolean;
  skipped: boolean;
  fingerprint: string;
  mappingVersion: string | null;
  selfMri: string | null;
  lossy: boolean;
  conversations: number;
  messages: number;
  people: number;
  earliestTs: number;
}
interface NativeAddon {
  nativeIngest(
    dir: string,
    destPath: string,
    schema: string,
    mappings: string[],
  ): NativeIngestResult;
  nativeRefresh(
    dir: string,
    prevPath: string,
    newPath: string,
    mappings: string[],
  ): NativeRefreshResult;
  conformanceVersion(): number;
}

// A native store's engine-PRIVATE refresh handle — the current .db file + the temp dir holding it —
// which rides opaquely in `Ingested.state` (libzaungast treats state as `unknown`). A later refresh
// reads the previous file and swaps to a new one.
interface NativeHandle {
  dbPath: string;
  tempDir: string;
}
const handleOf = (state: unknown): NativeHandle => (state as { native: NativeHandle }).native;

// Load the addon via the CJS loader (index.cjs). '../index.cjs' resolves from BOTH src/native.ts
// (dev, --conditions=development) and dist/native.js (built) — each is one level under the package
// root. Memoized; a missing/unloadable binary yields null (createNativeEngine reports it as data).
let cached: NativeAddon | null | undefined;
function loadAddon(): NativeAddon | null {
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    cached = require('../index.cjs') as NativeAddon;
  } catch {
    cached = null;
  }
  return cached;
}

// FULL ingest into a fresh throwaway dir; wrap the finished .db as an Ingested via the SPI factory,
// then stamp our private `{ native }` handle onto the opaque state (the SPI returns state:null).
function nativeFull(dir: string, addon: NativeAddon): Ingested {
  const tmp = mkdtempSync(join(tmpdir(), 'zaungast-native-'));
  const dbPath = join(tmp, 'store.db');
  const r = addon.nativeIngest(dir, dbPath, SCHEMA_SQL, loadBundledMappingTexts());
  const now = Date.now();
  const meta: StoreMeta = {
    asOf: now,
    fingerprint: r.fingerprint,
    mappingVersion: r.mappingVersion,
    schemaMatched: r.schemaMatched,
    counts: { conversations: r.conversations, messages: r.messages, people: r.people },
    earliestTs: r.earliestTs,
    ftsEnabled: r.ftsEnabled,
    lastFullAt: now,
    refreshMode: 'full',
    lossy: r.lossy,
    selfMri: r.selfMri,
  };
  const ing = openStoreFile(dbPath, meta, { ftsEnabled: r.ftsEnabled, tempDir: tmp });
  return { ...ing, state: { native: { dbPath, tempDir: tmp } } };
}

// One native incremental refresh: Rust copies prev → a new temp file, applies the delta, rewrites its
// meta. `needFullRebuild` (schema tripwire / stale) and `skipped` (lossy) discard the throwaway and
// leave the current store untouched — the Session full-rebuilds or keeps serving, respectively.
function nativeRefreshInto(dir: string, prev: NativeHandle, addon: NativeAddon): RefreshResult {
  const tmp = mkdtempSync(join(tmpdir(), 'zaungast-native-'));
  const dbPath = join(tmp, 'store.db');
  const r = addon.nativeRefresh(dir, prev.dbPath, dbPath, loadBundledMappingTexts());
  if (r.needFullRebuild || r.skipped) {
    rmSync(tmp, { recursive: true, force: true });
    return { kind: r.needFullRebuild ? 'needFull' : 'skipped' };
  }
  const now = Date.now();
  const meta: StoreMeta = {
    asOf: now,
    fingerprint: r.fingerprint,
    mappingVersion: r.mappingVersion,
    schemaMatched: true,
    counts: { conversations: r.conversations, messages: r.messages, people: r.people },
    earliestTs: r.earliestTs,
    ftsEnabled: true,
    lastFullAt: now, // the Session overwrites this with the real last-full time
    refreshMode: 'incremental',
    lossy: r.lossy,
    selfMri: r.selfMri,
  };
  const ing = openStoreFile(dbPath, meta, { ftsEnabled: true, tempDir: tmp });
  return { kind: 'swapped', next: { ...ing, state: { native: { dbPath, tempDir: tmp } } } };
}

// Why a native engine couldn't be constructed (reported as DATA, not thrown): the addon isn't
// installed / has no prebuilt for this platform, or its conformance version doesn't match the
// libzaungast this package targets. The consumer branches on `unavailable` to fall back to the JS
// engine — libzaungast never falls back on its own.
export type NativeUnavailable = { unavailable: string };

// Construct the native IngestEngine, or report why it can't be used. The conformance handshake runs
// once here at construction: the addon's conformanceVersion() must equal EXPECTED_CONFORMANCE (the
// reader's contract version) before any native output is trusted.
export function createNativeEngine(): IngestEngine | NativeUnavailable {
  const addon = loadAddon();
  if (!addon)
    return {
      unavailable: "the native addon isn't installed or has no prebuilt binary for this platform",
    };
  const conf = addon.conformanceVersion();
  if (conf !== EXPECTED_CONFORMANCE)
    return { unavailable: `native conformance ${conf} != expected ${EXPECTED_CONFORMANCE}` };
  return {
    full: (dir: string): Ingested => nativeFull(dir, addon),
    refresh: (prev: Ingested, dir: string): RefreshResult =>
      nativeRefreshInto(dir, handleOf(prev.state), addon),
  };
}
