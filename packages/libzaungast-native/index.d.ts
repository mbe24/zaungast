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

/** Conformance version — the TS `auto` engine only trusts native when this matches its expectation. */
export function conformanceVersion(): number;
