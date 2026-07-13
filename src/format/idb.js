// IndexedDB-on-LevelDB helpers: multi-sstable loader + Chromium key decoding.
import fs from 'node:fs'
import path from 'node:path'
import { readTable } from './sstable.js'
import { parseLog } from './wal.js'
import { deserialize } from './ssv.js'
import * as Snappy from './snappy.js'

// Load all live entries from a leveldb dir by scanning every .ldb table AND the .log WAL.
// Dedup by user key keeping the highest sequence number (LevelDB's own precedence rule);
// drop deletions (type 0). The WAL holds the newest writes (highest sequences), so merging
// it in gives a correct current snapshot including messages not yet compacted.
// `seqCap` (tests) ignores entries above a sequence, so the map holds OLDER versions of
// later-rewritten chains — letting an incremental genuinely exercise edits, not just inserts.
// `lossy` is true if any table/log failed to read fully (→ callers must not trust deletions).
/**
 * @param {string} dir
 * @param {{ includeLog?: boolean, seqCap?: bigint }} [opts]
 */
export function loadEntries(dir, { includeLog = true, seqCap } = {}) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ldb')).sort()
  const map = new Map() // userKeyHex -> { seq, type, key, value }
  let raw = 0, lossy = false

  const consider = (userKey, value, seq, type) => {
    if (seqCap !== undefined && seq > seqCap) return
    raw++
    const hex = userKey.toString('latin1')
    const cur = map.get(hex)
    if (!cur || seq > cur.seq) map.set(hex, { seq, type, key: Buffer.from(userKey), value: value ? Buffer.from(value) : null })
  }

  for (const f of files) {
    let res
    try { res = readTable(path.join(dir, f)) } catch (e) { console.error(`skip ${f}: ${e.message}`); lossy = true; continue }
    if (res.lossy) lossy = true
    for (const [ikey, value] of res.entries) {
      const n = ikey.length
      if (n < 8) { lossy = true; continue } // garbage entry from a block that parsed but is corrupt
      const tag = ikey.readBigUInt64LE(n - 8) // 8-byte trailer: (seq<<8 | type)
      consider(ikey.subarray(0, n - 8), value, tag >> 8n, Number(tag & 0xffn))
    }
  }

  if (includeLog) {
    // Always read the WAL — a freshly-compacted or young DB can hold all its data in the
    // .log with no .ldb tables yet; gating on files.length would ingest it as empty.
    const logFiles = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort()
    for (const lf of logFiles) {
      let batches
      try { batches = parseLog(path.join(dir, lf)) } catch (e) { console.error(`skip log ${lf}: ${e.message}`); lossy = true; continue }
      for (const b of batches) {
        // Each op in a batch gets sequence = batch.sequence + opIndex.
        b.ops.forEach((op, i) => consider(op.key, op.value, BigInt(b.sequence) + BigInt(i), op.type))
      }
    }
  }

  const live = []
  let maxSeq = 0n
  for (const e of map.values()) {
    if (e.seq > maxSeq) maxSeq = e.seq          // global high-water mark (incl. tombstones)
    if (e.type !== 0) live.push(e)
  }
  return { live, rawCount: raw, uniqueCount: map.size, maxSeq, lossy }
}

// COPY-REUSE loader (stage 2). `.ldb` files are immutable once named, so their parsed entries
// are cached by filename in `ldbCache` (Map<filename, {entries, lossy}>) and reused across
// refreshes; only `.log` files (small, append-only) are re-parsed each time. Detects compaction
// (a cached `.ldb` no longer present) via `compacted` — the caller MUST full-rebuild then,
// because compaction can elide tombstones (a deletion whose evidence is gone). Returns the same
// shape as loadEntries plus `compacted`. Mutates ldbCache (adds new files, prunes removed).
export function loadEntriesReuse(dir, ldbCache) {
  const all = fs.readdirSync(dir)
  const ldbNow = new Set(all.filter(f => f.endsWith('.ldb')))
  const logNow = all.filter(f => f.endsWith('.log')).sort()

  // compaction: any previously-cached .ldb file is gone
  let compacted = false
  for (const f of ldbCache.keys()) if (!ldbNow.has(f)) { compacted = true; break }

  const map = new Map()
  let raw = 0, lossy = false
  const consider = (userKey, value, seq, type) => {
    raw++
    const hex = userKey.toString('latin1')
    const cur = map.get(hex)
    if (!cur || seq > cur.seq) map.set(hex, { seq, type, key: Buffer.from(userKey), value: value ? Buffer.from(value) : null })
  }
  const ingestTable = (res) => {
    if (res.lossy) lossy = true
    for (const [ikey, value] of res.entries) {
      const n = ikey.length
      if (n < 8) { lossy = true; continue }
      const tag = ikey.readBigUInt64LE(n - 8)
      consider(ikey.subarray(0, n - 8), value, tag >> 8n, Number(tag & 0xffn))
    }
  }

  for (const f of [...ldbNow].sort()) {
    let res = ldbCache.get(f)
    if (!res) {
      try { res = readTable(path.join(dir, f)) } catch (e) { console.error(`skip ${f}: ${e.message}`); lossy = true; continue }
      // H-B: only cache a CLEAN parse — a partial (res.lossy) parse must be retried next refresh,
      // not frozen in the cache (which would pin copy-reuse in a permanent lossy/stale state).
      if (!res.lossy) ldbCache.set(f, res)
    }
    ingestTable(res)
  }
  // prune cache entries for .ldb files no longer present (freed after compaction full-rebuild)
  for (const f of [...ldbCache.keys()]) if (!ldbNow.has(f)) ldbCache.delete(f)

  for (const lf of logNow) {
    let batches
    try { batches = parseLog(path.join(dir, lf)) } catch (e) { console.error(`skip log ${lf}: ${e.message}`); lossy = true; continue }
    for (const b of batches) b.ops.forEach((op, i) => consider(op.key, op.value, BigInt(b.sequence) + BigInt(i), op.type))
  }

  const live = []
  let maxSeq = 0n
  for (const e of map.values()) { if (e.seq > maxSeq) maxSeq = e.seq; if (e.type !== 0) live.push(e) }
  return { live, maxSeq, lossy, compacted }
}

// ---- Chromium IndexedDB key coding ----
export function decodePrefix(buf) {
  const b0 = buf[0]
  const dbBytes = ((b0 >> 5) & 0x07) + 1
  const osBytes = ((b0 >> 2) & 0x07) + 1
  const idxBytes = (b0 & 0x03) + 1
  let p = 1
  // Chromium encodes the ids little-endian (EncodeInt / DecodeInt). Moot for single-byte
  // ids but correct for multi-byte ones.
  const readInt = (n) => { let v = 0; for (let i = 0; i < n; i++) v += buf[p++] * 2 ** (8 * i); return v }
  const databaseId = readInt(dbBytes)
  const objectStoreId = readInt(osBytes)
  const indexId = readInt(idxBytes)
  return { databaseId, objectStoreId, indexId, headerLen: p }
}

export function readVarint(buf, off) {
  let v = 0, shift = 0, pos = off
  while (true) { const c = buf[pos++]; v += (c & 0x7f) * 2 ** shift; if (!(c & 0x80)) break; shift += 7 }
  return [v, pos]
}

// UTF-16BE string with varint length prefix (in code units)
export function readStringWithLength(buf, off) {
  const [len, pos] = readVarint(buf, off)
  const chars = []
  for (let i = 0; i < len; i++) chars.push(String.fromCharCode((buf[pos + i * 2] << 8) | buf[pos + i * 2 + 1]))
  return [chars.join(''), pos + len * 2]
}

// Decode an IndexedDB object-store data VALUE into a JS object.
// Format: varint value-version, then either the raw Blink/V8 blob, OR Chromium's
// IndexedDB value-compression wrapper: header 0xFF 0x11 0x02 + a Snappy stream.
export function decodeValue(value, opts = {}) {
  const [, vpos] = readVarint(value, 0)
  let blob = value.subarray(vpos)
  // Chromium IndexedDB value wrapper: 0xFF 0x11 <method>. method 0x02 = Snappy-compressed
  // inline; other methods (e.g. 0x01) = value stored in EXTERNAL .blob files (app images,
  // large binaries) — not recoverable from leveldb alone, so return a marker.
  if (blob[0] === 0xff && blob[1] === 0x11) {
    const method = blob[2]
    if (method === 0x02) blob = Snappy.uncompress(blob.subarray(3))
    else return { __externalBlob: true, method }
  }
  return deserialize(blob, opts)
}

// UTF-16BE string filling the whole buffer (no length prefix) — used in some values
export function utf16be(buf) {
  const chars = []
  for (let i = 0; i + 1 < buf.length; i += 2) chars.push(String.fromCharCode((buf[i] << 8) | buf[i + 1]))
  return chars.join('')
}
