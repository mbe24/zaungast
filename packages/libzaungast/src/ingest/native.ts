// The optional native engine (seam A). libzaungast NEVER depends on `libzaungast-native`; a consumer
// opts in by installing it. This module probes for it, verifies a conformance handshake, and — when
// usable — has Rust read the leveldb dir and write the ChatStore .db end-to-end, which we then open
// read-only. On absence/mismatch the `auto` engine falls back to the JS ingest; an explicit `native`
// engine surfaces the reason instead. Native does FULL ingest only (incremental stays JS for now).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { ChatStore, SCHEMA_SQL, type StoreMeta } from './store.js';
import { loadBundledMappingTexts } from '../format/resolver.js';
import type { Ingested } from './ingest.js';

export type Engine = 'auto' | 'js' | 'native';

// The conformance version the TS side was built against. Native output is trusted (auto) only when
// the addon's conformanceVersion() matches. Bump in lockstep with libzaungast-native/src/bindings.rs
// whenever native output could diverge from the TS reference.
const EXPECTED_CONFORMANCE = 1;

interface NativeIngestResult {
  fingerprint: string;
  schemaMatched: boolean;
  schemaVersion: string | null;
  lossy: boolean;
  selfMri: string | null;
  conversations: number;
  messages: number;
  people: number;
  earliestTs: number;
  ftsEnabled: boolean;
}
interface NativeAddon {
  nativeIngest(
    dir: string,
    destPath: string,
    schema: string,
    mappings: string[],
  ): NativeIngestResult;
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

// Resolve the effective engine: explicit env override (ZAUNGAST_ENGINE) wins, then the option, else
// the default 'js'. An unrecognized env value is ignored (falls through to the option/default).
//
// Default is 'js' (NOT 'auto'): the native engine is not picked up implicitly, even when a prebuilt
// addon is present, until it's proven across platforms. Opt in per-call with engine:'auto'|'native'
// or globally with ZAUNGAST_ENGINE. Revisit the default once native has real multi-platform mileage.
export function resolveEngine(opt?: Engine): Engine {
  const env = (process.env.ZAUNGAST_ENGINE || '').toLowerCase();
  if (env === 'js' || env === 'native' || env === 'auto') return env;
  return opt ?? 'js';
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
    schemaVersion: r.schemaVersion,
    schemaMatched: r.schemaMatched,
    counts: { conversations: r.conversations, messages: r.messages, people: r.people },
    earliestTs: r.earliestTs,
    ftsEnabled: r.ftsEnabled,
    lastFullAt: now,
    refreshMode: 'full',
    lossy: r.lossy,
    selfMri: r.selfMri,
  };
  // state: null — native produces no incremental state yet, so a Session treats every refresh as a
  // full rebuild (native incremental is a deferred phase).
  return { store, meta, lossy: r.lossy, state: null };
}
