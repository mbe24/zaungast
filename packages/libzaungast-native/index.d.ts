/* Type surface of the native addon (kept in sync with src/bindings.rs). napi-rs also regenerates
 * this on `napi build`; committing it lets the TS engine switch type against the contract before any
 * platform .node exists. */

/** The result of a native full ingest — mirrors the fields TS folds into its StoreMeta. */
export interface IngestResult {
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

/**
 * Full ingest (seam A): read the leveldb `dir`, fingerprint + select among `mappings` (the bundled
 * mapping JSON texts from the libzaungast package), and write the ChatStore to `destPath`
 * (overwriting any prior file). `schema` is the single-source DDL string. Synchronous.
 */
export function nativeIngest(
  dir: string,
  destPath: string,
  schema: string,
  mappings: string[],
): IngestResult;

/** The result of a native incremental refresh (see nativeRefresh). */
export interface RefreshResult {
  /** delta couldn't apply (schema tripwire / stale file / mapping gone) — caller must full-rebuild. */
  needFullRebuild: boolean;
  /** lossy load — nothing applied; newPath is a byte-copy of prevPath; keep serving it. */
  skipped: boolean;
  fingerprint: string;
  schemaVersion: string | null;
  selfMri: string | null;
  lossy: boolean;
  conversations: number;
  messages: number;
  people: number;
  earliestTs: number;
}

/**
 * Incremental refresh (seam A): copy `prevPath` → `newPath`, apply the delta from `dir` up to the
 * current sequence, rewrite the new file's meta. The previous file is never mutated — on success the
 * caller swaps to `newPath`. `mappings` are the bundled JSON texts; the mapping is reused (by the
 * prev file's schemaVersion). Synchronous.
 */
export function nativeRefresh(
  dir: string,
  prevPath: string,
  newPath: string,
  mappings: string[],
): RefreshResult;

/** Conformance version — the TS `auto` engine only trusts native when this matches its expectation. */
export function conformanceVersion(): number;
