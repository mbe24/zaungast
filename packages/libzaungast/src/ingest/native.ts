// The optional native engine (seam A). libzaungast NEVER depends on `libzaungast-native`; a consumer
// opts in by installing it. This module probes for it, verifies a conformance handshake, and — when
// usable — has Rust read the leveldb dir and write the ChatStore .db end-to-end, which we then open
// read-only. On absence/mismatch the `auto` engine falls back to the JS ingest; an explicit `native`
// engine surfaces the reason instead. Native does FULL ingest only (incremental stays JS for now).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ChatStore, SCHEMA_SQL, type StoreMeta } from './store.js';
import { loadBundledMappingTexts } from '../format/resolver.js';
import type { Ingested } from './ingest.js';

// A native-built store's on-disk handle: the current .db file + the temp dir holding it. The Session
// keeps this on `Ingested.native` so a later native refresh can read the previous file + swap.
export interface NativeHandle {
  dbPath: string;
  tempDir: string;
}

// The conformance version the TS side was built against. Native output is trusted (auto) only when
// the addon's conformanceVersion() matches. Bump in lockstep with libzaungast-native/src/bindings.rs
// whenever native output could diverge from the TS reference.
const EXPECTED_CONFORMANCE = 1;

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

let cached: NativeAddon | null | undefined;
function loadAddon(): NativeAddon | null {
  if (cached !== undefined) return cached;
  try {
    const req = createRequire(import.meta.url);
    cached = req('libzaungast-native') as NativeAddon;
  } catch {
    cached = null; // not installed / no prebuilt binary for this platform
  }
  return cached;
}

// Run the native FULL ingest. Returns an Ingested on success, or null when native is unavailable and
// the caller may fall back (auto). Throws only for an explicit `native` request that can't be honored
// (not installed / conformance mismatch), or when the addon actively errors mid-ingest.
export function nativeIngest(dir: string, engine: 'auto' | 'native'): Ingested | null {
  const addon = loadAddon();
  if (!addon) {
    if (engine === 'native')
      throw new Error(
        "engine 'native' requested but the optional package 'libzaungast-native' is not installed " +
          '(or has no prebuilt binary for this platform)',
      );
    return null;
  }
  const conf = addon.conformanceVersion();
  if (conf !== EXPECTED_CONFORMANCE) {
    const msg = `libzaungast-native conformance ${conf} != expected ${EXPECTED_CONFORMANCE}`;
    if (engine === 'native') throw new Error(msg);
    console.warn(`[libzaungast] ${msg}; falling back to the JS engine`);
    return null;
  }

  // A throwaway dir for the native-built .db (+ any sqlite sidecars); removed on store.close().
  const tmp = mkdtempSync(join(tmpdir(), 'zaungast-native-'));
  const dbPath = join(tmp, 'store.db');
  const r = addon.nativeIngest(dir, dbPath, SCHEMA_SQL, loadBundledMappingTexts());
  const store = new ChatStore({ openFile: dbPath, ftsEnabled: r.ftsEnabled, tempFile: tmp });
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
  // state stays null (JS-side IngestState is unused for native); `native` carries the file handle so
  // the Session refreshes via nativeRefresh (new-file-swap) instead of JS applyIncremental.
  return { store, meta, lossy: r.lossy, state: null, native: { dbPath, tempDir: tmp } };
}

// One native incremental refresh. `dir` is the (already-snapshotted, static) leveldb dir the Session
// hands us; `prev` is the current native store's file handle. Rust copies prev→a new temp file,
// applies the delta, and rewrites its meta; we open the new file read-only and hand back a swapped
// store + meta. `needFullRebuild` (schema tripwire / stale file) and `skipped` (lossy) leave the
// current store untouched — the Session full-rebuilds or keeps serving, respectively.
export function nativeRefresh(
  dir: string,
  prev: NativeHandle,
):
  | { kind: 'swapped'; store: ChatStore; meta: StoreMeta; native: NativeHandle }
  | { kind: 'needFullRebuild' }
  | { kind: 'skipped' } {
  const addon = loadAddon();
  if (!addon) return { kind: 'needFullRebuild' }; // unreachable in practice (we only get here native)
  const tmp = mkdtempSync(join(tmpdir(), 'zaungast-native-'));
  const dbPath = join(tmp, 'store.db');
  const r = addon.nativeRefresh(dir, prev.dbPath, dbPath, loadBundledMappingTexts());
  if (r.needFullRebuild || r.skipped) {
    rmSync(tmp, { recursive: true, force: true }); // discard the throwaway; keep the current store
    return { kind: r.needFullRebuild ? 'needFullRebuild' : 'skipped' };
  }
  const store = new ChatStore({ openFile: dbPath, ftsEnabled: true, tempFile: tmp });
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
  return { kind: 'swapped', store, meta, native: { dbPath, tempDir: tmp } };
}
