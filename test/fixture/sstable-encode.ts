// LevelDB SSTable (.ldb) writer — the INVERSE of src/format/chromium/sstable.ts's readTable /
// parseBlock / readBlock. Read that file first (and its detailed header comment in this task's
// brief); this module writes exactly the bytes it reads back.
//
// Kept deliberately minimal: every table this writer produces has EXACTLY ONE data block (no
// prefix compression — `shared` is always 0, one restart point at offset 0), an empty metaindex
// block, and an index block with exactly one entry (key = the table's last user key, ignored by
// the reader; value = the BlockHandle of the sole data block). That's enough to round-trip
// through readTable()/loadEntries() faithfully; nothing in the reader requires multiple data
// blocks or restart-point prefix compression for correctness.
//
// Block format (both data and index blocks):
//   repeat { varint(shared=0) varint(nonShared=key.len) varint(valueLen) key value }
//   then tail: uint32LE(restartOffset=0) uint32LE(numRestarts=1)
// Block trailer (every block, incl. the empty metaindex): 1-byte compressionType(0=none) +
// 4-byte masked CRC32C computed over (blockContents ++ compressionTypeByte).
// Footer (48 bytes, at EOF-48): BlockHandle(metaindex) ++ BlockHandle(index) ++ zero pad to
// offset 40 ++ 8-byte magic (LE) at offset 40.
import { varint, crc32c, maskCrc } from './encode.js';

export interface TableEntryIn {
  key: Buffer;
  value: Buffer;
} // key = userKey ++ 8-byte trailer (already appended)
interface BlockHandleOut {
  offset: number;
  size: number;
}

const MAGIC = 0xdb4775248b80fb57n;

// ---- ikey trailer: userKey ++ 8-byte LE of (seq<<8 | type) — inverse of foldTable() in
// src/format/chromium/indexeddb.ts (`tag = ikey.readBigUInt64LE(n-8); seq = tag>>8n; type = tag&0xffn`).
export function ldbKey(userKey: Buffer, seq: bigint, type: 0 | 1): Buffer {
  const tag = (seq << 8n) | BigInt(type);
  const trailer = Buffer.alloc(8);
  trailer.writeBigUInt64LE(tag);
  return Buffer.concat([userKey, trailer]);
}

function blockHandleBytes(h: BlockHandleOut): Buffer {
  return Buffer.concat([varint(h.offset), varint(h.size)]);
}

// One block entry: shared=0 (no prefix compression — every entry carries its full key).
function encodeBlockEntry(key: Buffer, value: Buffer): Buffer {
  return Buffer.concat([varint(0), varint(key.length), varint(value.length), key, value]);
}

// Block tail with a single restart point: restart_offsets=[0], num_restarts=1.
function blockTail(): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(0, 0);
  b.writeUInt32LE(1, 4);
  return b;
}

// Raw (uncompressed) contents of a block: all entries back-to-back + the tail. An empty entry
// list yields just the 8-byte tail (the simplest valid block — e.g. an empty metaindex block).
function buildBlockContents(entries: { key: Buffer; value: Buffer }[]): Buffer {
  const parts: Buffer[] = entries.map((e) => encodeBlockEntry(e.key, e.value));
  parts.push(blockTail());
  return Buffer.concat(parts);
}

// Append the 5-byte trailer (compressionType=0 + masked CRC32C over contents++type) that every
// on-disk block needs, per readBlock()'s `Buffer.alloc(size + 5)` / `crc32c(buf, 0, size+1)`.
function finalizeBlock(contents: Buffer): Buffer {
  const type = Buffer.from([0]); // uncompressed
  const crc = maskCrc(crc32c(Buffer.concat([contents, type]), 0, contents.length + 1));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32LE(crc);
  return Buffer.concat([contents, type, crcBuf]);
}

// Build one complete, standalone .ldb file from a list of already-trailer-appended (ikey, value)
// pairs. Entries are sorted ascending by ikey (LevelDB requires keys within a table to be sorted;
// the reader itself doesn't enforce this for a full scan, but real .ldb files always are, and
// sorting keeps this writer faithful to the format it's inverting).
export function encodeTable(entries: TableEntryIn[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(a.key, b.key));

  const dataContents = buildBlockContents(sorted);
  const dataBlock = finalizeBlock(dataContents);
  const dataHandle: BlockHandleOut = { offset: 0, size: dataContents.length };

  // Empty metaindex block. readTable() parses the metaindex handle out of the footer but never
  // actually calls readBlock() on it — still emitted (empty-but-valid) for on-disk fidelity.
  const metaContents = buildBlockContents([]);
  const metaBlock = finalizeBlock(metaContents);
  const metaOffset = dataBlock.length;
  const metaHandle: BlockHandleOut = { offset: metaOffset, size: metaContents.length };

  // Index block: one entry pointing at the sole data block. The index KEY is a separator the
  // reader never inspects during a full scan (see parseBlock's usage in readTable — only the
  // VALUE, a BlockHandle, is read) — the last user ikey in the table is as good as any.
  const indexKey = sorted.length ? sorted.at(-1)!.key : Buffer.alloc(0);
  const indexContents = buildBlockContents([
    { key: indexKey, value: blockHandleBytes(dataHandle) },
  ]);
  const indexBlock = finalizeBlock(indexContents);
  const indexOffset = metaOffset + metaBlock.length;
  const indexHandle: BlockHandleOut = { offset: indexOffset, size: indexContents.length };

  const footer = Buffer.alloc(48);
  let pos = 0;
  const mh = blockHandleBytes(metaHandle);
  mh.copy(footer, pos);
  pos += mh.length;
  const ih = blockHandleBytes(indexHandle);
  ih.copy(footer, pos);
  // bytes [pos+ih.length, 40) stay zero (Buffer.alloc is zero-filled) — the footer's zero pad.
  footer.writeBigUInt64LE(MAGIC, 40);

  return Buffer.concat([dataBlock, metaBlock, indexBlock, footer]);
}
