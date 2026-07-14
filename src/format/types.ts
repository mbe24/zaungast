// Shared types for the LevelDB/IndexedDB reader stack (src/format/*).
// These describe the data structures the format modules produce, so callers
// (src/ingest, src/session.ts, src/tools/describeSchema.ts) get precise shapes
// without any module needing to import from another's private internals.

// ---- sstable.ts ----

// A LevelDB BlockHandle: offset+size of a block within an .ldb file.
export interface BlockHandle {
  offset: number;
  size: number;
}

// Result of reading one raw block (data or index) off disk.
export interface BlockReadResult {
  data: Buffer;
  compressionType: number;
  crcOk: boolean | null;
}

// One decoded (key, value) pair out of an SSTable, in on-disk order.
export type TableEntry = [Buffer, Buffer];

export interface TableReadResult {
  entries: TableEntry[];
  lossy: boolean;
}

// ---- wal.ts ----

export interface WalOp {
  type: number;
  key: Buffer;
  value: Buffer | null;
}

export interface WalBatch {
  sequence: number;
  ops: WalOp[];
}

// ---- idb.ts ----

// A single live (post-dedup) IndexedDB record, keyed by the raw Chromium
// user-key (WITHOUT the 8-byte seq/type trailer) plus the winning sequence/type.
export interface Entry {
  seq: bigint;
  type: number;
  key: Buffer;
  value: Buffer | null;
}

export interface LoadEntriesOptions {
  includeLog?: boolean;
  seqCap?: bigint;
}

export interface LoadEntriesResult {
  live: Entry[];
  rawCount: number;
  uniqueCount: number;
  maxSeq: bigint;
  lossy: boolean;
}

export interface LoadEntriesReuseResult {
  live: Entry[];
  maxSeq: bigint;
  lossy: boolean;
  compacted: boolean;
}

// Cache of already-parsed (immutable) .ldb tables, keyed by filename, used by
// the copy-reuse incremental path (loadEntriesReuse).
export type LdbCache = Map<string, TableReadResult>;

// Decoded Chromium IndexedDB key prefix (database/object-store/index ids).
export interface DecodedPrefix {
  databaseId: number;
  objectStoreId: number;
  indexId: number;
  headerLen: number;
}

// Marker returned by decodeValue when the actual payload lives in an external
// .blob file (not recoverable from leveldb alone).
export interface ExternalBlobMarker {
  __externalBlob: true;
  method: number;
}

// ---- ssv.ts (structured-clone deserializer) ----

export interface DeserializeOptions {
  debug?: boolean;
  lenient?: boolean;
}

// The structured-clone decoder produces genuinely dynamic JS values (whatever
// shape the serialized record had) — primitives, plain objects, arrays, Dates,
// or one of the marker objects below. Callers narrow with typeof/property
// checks, so this stays `unknown` rather than `any`.
export type SsvValue = unknown;

export interface ArrayBufferViewMarker {
  __arrayBufferView: number;
}

export interface RegExpMarker {
  __regexp: unknown;
  flags: number;
}

export interface PartialObjectMarker {
  __partial: true;
}

// ---- fingerprint.ts ----

export interface FingerprintStore {
  db: string;
  store: string;
  fields: string[];
}

export interface FingerprintResult {
  hash: string;
  storeCount: number;
  stores: FingerprintStore[];
  dbCount: number;
}

// ---- discover.ts ----

export interface DiscoverOptions {
  override?: string;
}

export interface DiscoverCandidate {
  dir: string;
  source: 'override' | 'auto';
  mtime: number;
  valid?: boolean;
  package?: string;
  profile?: string;
  origin?: string;
}

// ---- resolver.ts / schema mapping files (src/schema/versions/*.json) ----

export interface EntityDef {
  db: string;
  store: string;
  fields: Record<string, string | string[]>;
  iterate?: string;
  keep?: { field: string; equals: unknown };
}

export interface Mapping {
  schemaVersion: string;
  description?: string;
  knownFingerprints?: string[];
  match?: { requireStores?: string[] };
  entities: Record<string, EntityDef>;
}

export interface SelectMappingResult {
  mapping: Mapping | null;
  via: string;
}

// A row extracted from a mapped entity: the mapped fields plus `__key`, the
// source record's raw leveldb user-key (latin1), for grouping by chain.
export interface ExtractedRow {
  __key: string;
  [field: string]: unknown;
}
