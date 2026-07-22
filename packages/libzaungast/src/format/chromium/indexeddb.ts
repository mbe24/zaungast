// IndexedDB-on-LevelDB helpers: multi-sstable loader + Chromium key decoding.
import fs from 'node:fs';
import path from 'node:path';
import { readTable } from './sstable.js';
import { parseWriteAheadLog } from './write-ahead-log.js';
import { deserialize } from './structured-clone.js';
import * as Snappy from './snappy.js';
import { byCodeUnit } from '../../util/sort.js';
import type {
  DecodedPrefix,
  DeserializeOptions,
  SnapshotRecord,
  ExternalBlobMarker,
  LdbCache,
  LoadEntriesOptions,
  LoadEntriesResult,
  LoadEntriesReuseResult,
  Snapshot,
  SsvValue,
  StoreBucket,
  TableReadResult,
  WalBatch,
} from '../types.js';

// A sink for candidate records; the loaders below feed one of these while deduping by user key.
type Consider = (userKey: Buffer, value: Buffer | null, seq: number, type: number) => void;

// Split each entry's 8-byte LevelDB trailer (seq<<8 | type) and feed it to `consider`. Returns
// true if any entry was too short to carry a trailer (garbage from a block that parsed but is
// corrupt) — the caller marks the load lossy.
function foldTable(res: TableReadResult, consider: Consider): boolean {
  let short = false;
  for (const [ikey, value] of res.entries) {
    const n = ikey.length;
    if (n < 8) {
      short = true;
      continue;
    }
    // 8-byte trailer: type | (seq << 8). byte[n-8]=type, bytes[n-7..n-1]=seq (56-bit LE).
    const type = ikey[n - 8];
    const seqHi = ikey[n - 1]; // top 8 bits of the 56-bit seq
    if (seqHi >= 0x20) throw new Error('leveldb seq exceeds 2^53 — widen seq handling'); // 0x20*2^48 == 2^53
    const seq = seqHi * 0x1000000000000 + ikey.readUIntLE(n - 7, 6); // hi*2^48 + low 48 bits (exact, < 2^53)
    consider(ikey.subarray(0, n - 8), value, seq, type);
  }
  return short;
}

// Fold a WAL batch's ops into `consider`; each op's sequence = batch.sequence + opIndex.
function foldBatch(batch: WalBatch, consider: Consider): void {
  batch.ops.forEach((op, i) => consider(op.key, op.value, batch.sequence + i, op.type));
}

// Read each `.ldb` file and fold its entries into `consider`. When `cache` is given (the
// copy-reuse path), a cache hit skips reading the file from disk entirely, and a clean
// (non-lossy) parse is stored for next time — H-B: a partial parse must NEVER be cached, or
// copy-reuse would pin itself in a permanent lossy/stale state. Returns true if any file failed
// to read or read lossily (caller marks the whole load lossy).
function readTablesInto(
  dir: string,
  files: string[],
  consider: Consider,
  cache?: LdbCache,
): boolean {
  let lossy = false;
  for (const f of files) {
    let hit = cache?.get(f);
    // Self-validate a cache hit by on-disk size: `.ldb` are immutable by name, so a size change means
    // the file was re-copied (H-A partial→complete, or the rare H-C filename reuse) → the cached parse
    // is stale, drop it and re-read. (snapshotReuse still re-copies on a live-vs-snapshot size diff —
    // that re-copy is what changes the size we re-stat here; the engine can't see the live file.)
    if (hit) {
      let curSize = -1;
      try {
        curSize = fs.statSync(path.join(dir, f)).size;
      } catch {
        curSize = -1;
      }
      if (curSize !== hit.size) hit = undefined;
    }
    let res = hit?.res;
    if (!res) {
      try {
        res = readTable(path.join(dir, f));
      } catch (e) {
        console.error(`skip ${f}: ${(e as Error).message}`);
        lossy = true;
        continue;
      }
      // Cache a CLEAN parse with its on-disk size (for the self-validation above). Only when a cache
      // is in play — the non-reuse loadSnapshot path passes no cache and must not pay an extra stat.
      // A stat failure just skips caching (the read itself already succeeded — never mark it lossy).
      if (cache && !res.lossy) {
        let size = -1;
        try {
          size = fs.statSync(path.join(dir, f)).size;
        } catch {
          size = -1;
        }
        if (size >= 0) cache.set(f, { res, size });
      }
    }
    if (res.lossy) lossy = true;
    if (foldTable(res, consider)) lossy = true;
  }
  return lossy;
}

// Parse each `.log` file and fold its batches into `consider`. Returns true if any log failed to
// parse (caller marks the whole load lossy).
function readLogsInto(dir: string, logFiles: string[], consider: Consider): boolean {
  let lossy = false;
  for (const lf of logFiles) {
    let batches: WalBatch[];
    try {
      batches = parseWriteAheadLog(path.join(dir, lf));
    } catch (e) {
      console.error(`skip log ${lf}: ${(e as Error).message}`);
      lossy = true;
      continue;
    }
    for (const b of batches) foldBatch(b, consider);
  }
  return lossy;
}

// Collect the surviving (non-tombstone) entries plus the global high-water sequence.
function collectLive(map: Map<string, SnapshotRecord>): { live: SnapshotRecord[]; maxSeq: number } {
  const live: SnapshotRecord[] = [];
  let maxSeq = 0;
  for (const e of map.values()) {
    if (e.seq > maxSeq) maxSeq = e.seq; // global high-water mark (incl. tombstones)
    if (e.type !== 0) live.push(e);
  }
  return { live, maxSeq };
}

// One pass over the deduped map that classifies each record once: decode its key prefix, route
// db-name / store-name catalog rows into the name maps, and append indexId===1 data records to
// their object-store bucket (in dedup-insertion order — fingerprint sampling depends on it). This
// is the engine-seam producer: everything downstream reads `Snapshot`, not raw Chromium keys.
function collectSnapshot(map: Map<string, SnapshotRecord>, raw: number, lossy: boolean): Snapshot {
  const dbNames = new Map<number, string>();
  const storeNames = new Map<string, string>();
  const buckets = new Map<string, StoreBucket>();
  let maxSeq = 0;
  for (const e of map.values()) {
    if (e.seq > maxSeq) maxSeq = e.seq; // global high-water (incl. tombstones)
    if (e.type === 0) continue; // tombstone: bumps maxSeq only, never appears in a bucket
    const key = e.key;
    if (key.length < 1) continue;
    let p: DecodedPrefix;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    const { databaseId, objectStoreId, indexId, headerLen } = p;
    if (databaseId === 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0xc9) {
      // db-name catalog row: origin + db name in the key, dbId as a varint value.
      const [, p2] = readStringWithLength(key, headerLen + 1);
      const [name] = readStringWithLength(key, p2);
      const [id] = readVarint(e.value, 0); // value non-null (non-tombstone)
      dbNames.set(id, name);
    } else if (databaseId > 0 && objectStoreId === 0 && indexId === 0 && key[headerLen] === 0x32) {
      // store-name catalog row: osId varint in the key, store name (utf16be) in the value.
      const [osId, pp] = readVarint(key, headerLen + 1);
      if (key[pp] === 0) storeNames.set(`${databaseId}:${osId}`, utf16be(e.value));
    } else if (indexId === 1) {
      const bk = `${databaseId}:${objectStoreId}`;
      let b = buckets.get(bk);
      if (!b) {
        b = {
          dbId: databaseId,
          osId: objectStoreId,
          dbName: null,
          storeName: null,
          records: [],
          maxSeq: 0,
        };
        buckets.set(bk, b);
      }
      b.records.push(e);
      if (e.seq > b.maxSeq) b.maxSeq = e.seq;
    }
  }
  // back-fill resolved names onto each bucket
  for (const b of buckets.values()) {
    b.storeName = storeNames.get(`${b.dbId}:${b.osId}`) ?? null;
    b.dbName = dbNames.get(b.dbId) ?? null;
  }
  return { buckets, dbNames, storeNames, maxSeq, rawCount: raw, uniqueCount: map.size, lossy };
}

// Load all live entries from a leveldb dir by scanning every .ldb table AND the .log WAL.
// Dedup by user key keeping the highest sequence number (LevelDB's own precedence rule);
// drop deletions (type 0). The WAL holds the newest writes (highest sequences), so merging
// it in gives a correct current snapshot including messages not yet compacted.
// `seqCap` (tests) ignores entries above a sequence, so the map holds OLDER versions of
// later-rewritten chains — letting an incremental genuinely exercise edits, not just inserts.
// `lossy` is true if any table/log failed to read fully (→ callers must not trust deletions).
// Build the deduped `userKeyHex -> SnapshotRecord` map by scanning every .ldb table + the .log WAL.
// Shared by loadEntries (→ flat live[]) and loadSnapshot (→ grouped buckets).
function buildDedupMap(
  dir: string,
  { includeLog = true, seqCap }: LoadEntriesOptions = {},
): { map: Map<string, SnapshotRecord>; raw: number; lossy: boolean } {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ldb'))
    .sort(byCodeUnit);
  const map = new Map<string, SnapshotRecord>(); // userKeyHex -> { seq, type, key, value }
  let raw = 0,
    lossy = false;

  // Store the incoming key/value by reference (they are private views over the read file buffers,
  // which nobody mutates) and mutate the winning slot in place on overwrite — no per-entry copy.
  const consider: Consider = (userKey, value, seq, type) => {
    if (seqCap !== undefined && seq > seqCap) return;
    raw++;
    const hex = userKey.toString('latin1');
    const cur = map.get(hex);
    if (!cur) map.set(hex, { seq, type, key: userKey, value });
    else if (seq > cur.seq) {
      cur.seq = seq;
      cur.type = type;
      cur.key = userKey;
      cur.value = value;
    }
  };

  if (readTablesInto(dir, files, consider)) lossy = true;
  if (includeLog) {
    // Always read the WAL — a freshly-compacted or young DB can hold all its data in the
    // .log with no .ldb tables yet; gating on files.length would ingest it as empty.
    const logFiles = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .sort(byCodeUnit);
    if (readLogsInto(dir, logFiles, consider)) lossy = true;
  }
  return { map, raw, lossy };
}

export function loadEntries(dir: string, opts: LoadEntriesOptions = {}): LoadEntriesResult {
  const { map, raw, lossy } = buildDedupMap(dir, opts);
  const { live, maxSeq } = collectLive(map);
  return { live, rawCount: raw, uniqueCount: map.size, maxSeq, lossy };
}

// Engine-seam loader: same read+dedup as loadEntries, then one grouping pass → a `Snapshot`
// (buckets + resolved db/store-name catalog). Consumers (fingerprint/entityTargets/extractEntity)
// read the snapshot, never raw Chromium keys.
export function loadSnapshot(dir: string, opts: LoadEntriesOptions = {}): Snapshot {
  const { map, raw, lossy } = buildDedupMap(dir, opts);
  return collectSnapshot(map, raw, lossy);
}

// COPY-REUSE loader (stage 2). `.ldb` files are immutable once named, so their parsed entries
// are cached by filename in `ldbCache` (Map<filename, {entries, lossy}>) and reused across
// refreshes; only `.log` files (small, append-only) are re-parsed each time. Detects compaction
// (a cached `.ldb` no longer present) via `compacted` — the caller MUST full-rebuild then,
// because compaction can elide tombstones (a deletion whose evidence is gone). Returns the same
// shape as loadEntries plus `compacted`. Mutates ldbCache (adds new files, prunes removed).
function buildReuseMap(
  dir: string,
  ldbCache: LdbCache,
): { map: Map<string, SnapshotRecord>; raw: number; lossy: boolean; compacted: boolean } {
  const all = fs.readdirSync(dir);
  const ldbNow = new Set(all.filter((f) => f.endsWith('.ldb')));
  const logNow = all.filter((f) => f.endsWith('.log')).sort(byCodeUnit);

  // compaction: any previously-cached .ldb file is gone
  let compacted = false;
  for (const f of ldbCache.keys())
    if (!ldbNow.has(f)) {
      compacted = true;
      break;
    }

  const map = new Map<string, SnapshotRecord>();
  let raw = 0,
    lossy = false;
  const consider: Consider = (userKey, value, seq, type) => {
    raw++;
    const hex = userKey.toString('latin1');
    const cur = map.get(hex);
    if (!cur) map.set(hex, { seq, type, key: userKey, value });
    else if (seq > cur.seq) {
      cur.seq = seq;
      cur.type = type;
      cur.key = userKey;
      cur.value = value;
    }
  };

  // H-B: only cache a CLEAN parse — a partial (res.lossy) parse must be retried next refresh, not
  // frozen in the cache (which would pin copy-reuse in a permanent lossy/stale state). Handled
  // inside readTablesInto, which also serves cache hits without touching disk.
  if (readTablesInto(dir, [...ldbNow].sort(byCodeUnit), consider, ldbCache)) lossy = true;
  // Prune cache entries for .ldb files no longer present (freed after compaction full-rebuild).
  // Snapshot the keys first: we delete from the map inside the loop.
  for (const f of [...ldbCache.keys()]) if (!ldbNow.has(f)) ldbCache.delete(f);

  if (readLogsInto(dir, logNow, consider)) lossy = true;
  return { map, raw, lossy, compacted };
}

export function loadEntriesReuse(dir: string, ldbCache: LdbCache): LoadEntriesReuseResult {
  const { map, lossy, compacted } = buildReuseMap(dir, ldbCache);
  const { live, maxSeq } = collectLive(map);
  return { live, maxSeq, lossy, compacted };
}

// Copy-reuse variant of loadSnapshot: same cached-`.ldb` reuse + compaction detection, grouped
// into a Snapshot.
export function loadSnapshotReuse(
  dir: string,
  ldbCache: LdbCache,
): Snapshot & { compacted: boolean } {
  const { map, raw, lossy, compacted } = buildReuseMap(dir, ldbCache);
  return { ...collectSnapshot(map, raw, lossy), compacted };
}

// ---- Chromium IndexedDB key coding ----
export function decodePrefix(buf: Buffer): DecodedPrefix {
  const b0 = buf[0];
  const dbBytes = ((b0 >> 5) & 0x07) + 1;
  const osBytes = ((b0 >> 2) & 0x07) + 1;
  const idxBytes = (b0 & 0x03) + 1;
  let p = 1;
  // Chromium encodes the ids little-endian (EncodeInt / DecodeInt). Moot for single-byte
  // ids but correct for multi-byte ones.
  const readInt = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v += buf[p++] * 2 ** (8 * i);
    return v;
  };
  const databaseId = readInt(dbBytes);
  const objectStoreId = readInt(osBytes);
  const indexId = readInt(idxBytes);
  return { databaseId, objectStoreId, indexId, headerLen: p };
}

// `buf` is typed to also accept `null` because callers commonly pass an `SnapshotRecord.value`
// (which is `Buffer | null` for the tombstone case) straight through without a guard, exactly
// as the untyped original did. The cast below has no runtime effect — a null `buf` still
// throws the same TypeError on first access as the original unguarded `buf[pos++]` did.
export function readVarint(buf: Buffer | null, off: number): [number, number] {
  let v = 0,
    shift = 0,
    pos = off;
  const b = buf as Buffer;
  while (true) {
    const c = b[pos++];
    v += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) break;
    shift += 7;
  }
  return [v, pos];
}

// UTF-16BE string with varint length prefix (in code units)
export function readStringWithLength(buf: Buffer, off: number): [string, number] {
  const [len, pos] = readVarint(buf, off);
  const chars: string[] = [];
  for (let i = 0; i < len; i++)
    chars.push(String.fromCharCode((buf[pos + i * 2] << 8) | buf[pos + i * 2 + 1])); // NOSONAR S7758 — UTF-16 code units by design (see verify.ts round-trip)
  return [chars.join(''), pos + len * 2];
}

// Grow-only scratch for per-value Snappy decompression. Safe to reuse across calls because nothing
// deserialize() returns retains a view into the decompressed buffer (strings → toString copy,
// ArrayBuffers → Buffer.from copy; audited), and each decoded value is consumed synchronously
// before the next decodeValue call. NOT used for sstable block decompression (those buffers must
// persist as value backing). Bounded by the largest single value ever decompressed.
let ssvScratch: Buffer = Buffer.allocUnsafe(0);

// Decode an IndexedDB object-store data VALUE into a JS object.
// Format: varint value-version, then either the raw Blink/V8 blob, OR Chromium's
// IndexedDB value-compression wrapper: header 0xFF 0x11 0x02 + a Snappy stream.
export function decodeValue(
  value: Buffer | null,
  opts: DeserializeOptions = {},
): SsvValue | ExternalBlobMarker {
  const [, vpos] = readVarint(value, 0);
  let blob = (value as Buffer).subarray(vpos);
  // Chromium IndexedDB value wrapper: 0xFF 0x11 <method>. method 0x02 = Snappy-compressed
  // inline; other methods (e.g. 0x01) = value stored in EXTERNAL .blob files (app images,
  // large binaries) — not recoverable from leveldb alone, so return a marker.
  if (blob[0] === 0xff && blob[1] === 0x11) {
    const method = blob[2];
    if (method === 0x02) {
      blob = Snappy.uncompress(blob.subarray(3), ssvScratch);
      if (blob.length > ssvScratch.length) ssvScratch = blob; // adopt the larger buffer (grow-only)
    } else return { __externalBlob: true, method };
  }
  return deserialize(blob, opts);
}

// UTF-16BE string filling the whole buffer (no length prefix) — used in some values
export function utf16be(buf: Buffer | null): string {
  const b = buf as Buffer;
  const chars: string[] = [];
  for (let i = 0; i + 1 < b.length; i += 2) chars.push(String.fromCharCode((b[i] << 8) | b[i + 1])); // NOSONAR S7758 — UTF-16 code units by design (see verify.ts round-trip)
  return chars.join('');
}
