// Read-only reader for the Chromium "blockfile" HTTP disk cache (Teams' EBWebView profile
// `Cache/Cache_Data`: index + data_0..data_N + f_XXXXXX). Teams renders pasted chat images from AMS
// (`…/v1/objects/<id>/views/imgo`); once displayed, the response body usually sits in this cache.
// We only READ the files (never write/lock), and we never touch the network.
//
// Layout (net/disk_cache/blockfile/disk_format*.h):
//   data_N  = 8 KiB BlockFileHeader + fixed-size blocks; header.entry_size @12, header.next_file @10.
//   EntryStore (256-byte blocks, data_1 + its next_file chain): state @20, key_len @32, long_key @36,
//     data_size[4] @40, data_addr[4] @56, key @96 (inline, may span up to 4 blocks).
//   CacheAddr: bit31 initialized, bits28-30 file type (0 = external f_XXXXXX, 1 rankings, 2 = 256B,
//     3 = 1 KiB, 4 = 4 KiB), bits16-23 file selector (data_N), low 16 bits start block.
//   Stream 0 = pickled HttpResponseInfo (raw headers, NUL-separated); stream 1 = response body.
import fs from 'node:fs';
import path from 'node:path';

const HEADER_SIZE = 8192;
const ENTRY_NORMAL = 0;
const MAX_KEY = 4096;

export interface CachedObject {
  key: string; // the cache key (contains the request URL)
  view: string; // AMS view (imgo, imgpsh_fullsize_anim, …) or '' when the key has none
  mimeType: string; // sniffed from the body (jpeg/png/gif/webp) — what the image actually is
  contentType: string | null; // as the server declared it
  contentLength: number | null;
  body: Buffer;
}

interface EntryRef {
  key: string;
  view: string;
  sizes: number[];
  addrs: number[];
}

// AMS views in preference order (full-size first; thumbnails/avatars last).
const VIEW_RANK = ['imgo', 'imgpsh_fullsize_anim', 'imgpsh_fullsize', 'imgpsh_mobile_save_anim'];
const viewScore = (v: string): number => {
  const i = VIEW_RANK.indexOf(v);
  if (i >= 0) return i;
  return /thumb|avatar|imgt/i.test(v) ? 100 : 50;
};

const OBJ_RE = /\/objects\/([0-9A-Za-z_-]{8,})(?:\/views\/([A-Za-z0-9_]+))?/;
// A cache key is a URL, optionally prefixed by Chromium's partition ("1/0/_dk_<site> <site> ").
const KEY_RE = /^(?:\d\/\d\/)?(?:_dk_\S+ \S+ )?https?:\/\//;

export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.readUInt32BE(0) === 0x89504e47) return 'image/png';
  if (b.length >= 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp';
  // Only the formats an MCP client (Claude) accepts as image content; anything else is skipped.
  return null;
}

// BlockFileHeader.allocation_map (@80): one bit per block, set while the block is in use. Freed
// blocks keep their old bytes, so this is what tells a live entry/body from a stale one.
function allocated(buf: Buffer, block: number): boolean {
  const word = 80 + (block >>> 5) * 4;
  if (block < 0 || word + 4 > HEADER_SIZE) return false;
  return ((buf.readUInt32LE(word) >>> (block & 31)) & 1) === 1;
}

export class HttpCache {
  private readonly files = new Map<number, Buffer | null>();
  private byObject: Map<string, EntryRef[]> | null = null;

  constructor(readonly dir: string) {}

  static exists(dir: string): boolean {
    try {
      return (
        fs.statSync(path.join(dir, 'data_1')).isFile() &&
        fs.statSync(path.join(dir, 'index')).isFile()
      );
    } catch {
      return false;
    }
  }

  private blockFile(n: number): Buffer | null {
    if (!this.files.has(n)) {
      let buf: Buffer | null = null;
      try {
        buf = fs.readFileSync(path.join(this.dir, `data_${n}`));
      } catch {
        buf = null;
      }
      this.files.set(n, buf && buf.length >= HEADER_SIZE ? buf : null);
    }
    return this.files.get(n)!;
  }

  // Resolve a CacheAddr to its bytes (exactly `size` bytes, or null when unreadable/out of bounds).
  private read(addr: number, size: number): Buffer | null {
    if (!(addr & 0x80000000) || size <= 0) return null;
    const type = (addr & 0x70000000) >>> 28;
    if (type === 0) {
      const name = 'f_' + (addr & 0x0fffffff).toString(16).padStart(6, '0');
      try {
        const b = fs.readFileSync(path.join(this.dir, name));
        return b.length >= size ? b.subarray(0, size) : null;
      } catch {
        return null;
      }
    }
    if (type < 2 || type > 4) return null;
    const buf = this.blockFile((addr & 0x00ff0000) >>> 16);
    if (!buf) return null;
    const blockSize = buf.readInt32LE(12);
    const start = addr & 0xffff;
    const off = HEADER_SIZE + start * blockSize;
    if (blockSize <= 0 || off + size > buf.length || !allocated(buf, start)) return null;
    return buf.subarray(off, off + size);
  }

  // Scan the entry block files (data_1 and its next_file chain) once, indexing every live entry
  // whose key references an AMS object id. Scanning blocks (instead of walking the index hash
  // table) is simpler and tolerant of a cache Teams is writing to; stale blocks are filtered by
  // the allocation bitmap (entry AND body blocks), state, key shape, and by sniffing the body.
  private index(): Map<string, EntryRef[]> {
    if (this.byObject) return this.byObject;
    const map = new Map<string, EntryRef[]>();
    const seen = new Set<number>();
    for (let n = 1; n > 0 && !seen.has(n);) {
      seen.add(n);
      const buf = this.blockFile(n);
      if (!buf) break;
      const es = buf.readInt32LE(12);
      if (es === 256) {
        for (let off = HEADER_SIZE; off + es <= buf.length; off += es) {
          if (!allocated(buf, (off - HEADER_SIZE) / es)) continue;
          const keyLen = buf.readInt32LE(off + 32);
          if (keyLen <= 0 || keyLen > MAX_KEY) continue;
          if (buf.readInt32LE(off + 20) !== ENTRY_NORMAL) continue;
          const longKey = buf.readUInt32LE(off + 36);
          const keyBuf = longKey
            ? this.read(longKey, keyLen)
            : off + 96 + keyLen <= buf.length
              ? buf.subarray(off + 96, off + 96 + keyLen)
              : null;
          if (!keyBuf) continue;
          const key = keyBuf.toString('latin1');
          if (!KEY_RE.test(key)) continue;
          const m = OBJ_RE.exec(key);
          if (!m) continue;
          const ref: EntryRef = {
            key,
            view: m[2] ?? '',
            sizes: [0, 1, 2, 3].map((i) => buf.readInt32LE(off + 40 + i * 4)),
            addrs: [0, 1, 2, 3].map((i) => buf.readUInt32LE(off + 56 + i * 4)),
          };
          const list = map.get(m[1]) ?? [];
          list.push(ref);
          map.set(m[1], list);
        }
      }
      n = buf.readInt16LE(10);
    }
    this.byObject = map;
    return map;
  }

  // Best cached image body for an AMS object id: full-size view first, then the largest body.
  // Only bodies that sniff as an image are returned (guards against stale/reused blocks).
  findObject(objectId: string): CachedObject | null {
    const refs = [...(this.index().get(objectId) ?? [])]
      .filter((r) => r.sizes[1] > 0)
      .sort((a, b) => viewScore(a.view) - viewScore(b.view) || b.sizes[1] - a.sizes[1]);
    for (const r of refs) {
      const body = this.read(r.addrs[1], r.sizes[1]);
      const mimeType = body ? sniffImage(body) : null;
      if (!body || !mimeType) continue;
      const head = this.read(r.addrs[0], r.sizes[0]);
      const headers = head ? head.toString('latin1') : '';
      const ct = /content-type:\s*([^\0\r\n;]+)/i.exec(headers)?.[1]?.trim() ?? null;
      const cl = /content-length:\s*(\d+)/i.exec(headers)?.[1];
      if (/content-encoding:\s*(?!identity)\S/i.test(headers)) continue; // compressed body: skip
      return {
        key: r.key,
        view: r.view,
        mimeType,
        contentType: ct,
        contentLength: cl ? Number(cl) : null,
        body: Buffer.from(body),
      };
    }
    return null;
  }
}
