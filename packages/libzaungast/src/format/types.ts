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
export interface SnapshotRecord {
  seq: number;
  type: number;
  key: Buffer;
  value: Buffer | null;
}

export interface LoadEntriesOptions {
  includeLog?: boolean;
  seqCap?: number;
}

export interface LoadEntriesResult {
  live: SnapshotRecord[];
  rawCount: number;
  uniqueCount: number;
  maxSeq: number;
  lossy: boolean;
}

export interface LoadEntriesReuseResult {
  live: SnapshotRecord[];
  maxSeq: number;
  lossy: boolean;
  compacted: boolean;
}

// Cache of already-parsed (immutable) .ldb tables, keyed by filename, used by
// the copy-reuse incremental path (loadEntriesReuse).
export type LdbCache = Map<string, TableReadResult>;

// ---- Snapshot: the engine seam ----
// A `Snapshot` is what a storage engine produces: live records already grouped by object store,
// with the db/store-name catalog resolved, so the schema/extract layer never touches engine key
// coding. (Value bytes stay raw — value-decode remains a documented per-engine dependency.)

// One object store's live (indexId===1, post-dedup) records, plus resolved names.
export interface StoreBucket {
  dbId: number;
  osId: number;
  dbName: string | null; // resolved by the loader from the db-name catalog rows
  storeName: string | null;
  records: SnapshotRecord[]; // dedup-insertion order (fingerprint sampling depends on it)
  maxSeq: number; // high-water over this store's live records (see api-design §2.6)
}

export interface Snapshot {
  buckets: Map<string, StoreBucket>; // key `${dbId}:${osId}`
  dbNames: Map<number, string>; // dbId -> normalized-free db name (catalog)
  storeNames: Map<string, string>; // `${dbId}:${osId}` -> store name (catalog)
  maxSeq: number; // global high-water (INCLUDING tombstones)
  rawCount: number;
  uniqueCount: number;
  lossy: boolean;
}

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

// Marker for an embedded Blink Blob host object (V8 kHostObject / Blink kBlobTag). URL-only
// design: we never decode the media bytes — only the metadata needed to advance the cursor.
export interface BlobMarker {
  __blob: { type: string; size: number };
}

// Marker for a Blink Blob/File-by-index host object (kBlobIndexTag 'i' / kFileIndexTag 'e'):
// the payload lives in a side blob_info array we don't have, so we surface only the index.
export interface BlobIndexMarker {
  __blobIndex: number;
  __file?: boolean;
}

export type HostObjectMarker = BlobMarker | BlobIndexMarker;

export interface PartialObjectMarker {
  __partial: true;
}

// ---- fingerprint.ts ----

export interface SchemaStore {
  db: string;
  store: string;
  fields: string[];
}

export interface Fingerprint {
  hash: string;
  storeCount: number;
  stores: SchemaStore[];
  dbCount: number;
}

// ---- discover.ts ----

export interface DiscoverOptions {
  override?: string;
}

export interface DiscoveredStore {
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
  mappingVersion: string; // semver of THIS mapping artifact (our revision), not a Teams version
  description?: string;
  knownFingerprints?: string[];
  match?: { requireStores?: string[] };
  entities: Record<string, EntityDef>;
}

export interface MappingMatch {
  mapping: Mapping | null;
  via: string;
}

// A row extracted from a mapped entity: the mapped fields plus `__key`, the
// source record's raw leveldb user-key (latin1), for grouping by chain.
export interface EntityRecord {
  __key: string;
  [field: string]: unknown;
}

// The result of extracting one entity from a snapshot (uniform error semantics, Category 3 —
// partiality). `records` are the extracted rows; `decoded`/`dropped` count source records that
// decoded vs failed to decode, so a consumer can surface extraction health without inspecting rows.
export interface EntityExtract {
  records: EntityRecord[];
  decoded: number;
  dropped: number;
}
