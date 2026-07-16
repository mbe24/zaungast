// Snappy raw-block decompressor (not the framed format).
// Format: varint uncompressed-length, then a stream of elements:
//   tag&3 == 0  literal:      len-1 in tag>>2 (or, if >=60, in the next (val-59) LE bytes)
//   tag&3 == 1  copy 1-byte:  len = ((tag>>2)&7)+4 ; offset = ((tag>>5)<<8) | next byte
//   tag&3 == 2  copy 2-byte:  len = (tag>>2)+1     ; offset = next 2 bytes LE
//   tag&3 == 3  copy 4-byte:  len = (tag>>2)+1     ; offset = next 4 bytes LE
// Copies may overlap (offset < len). The copy loop reproduces snappy's byte-feed-forward overlap
// semantics with growing non-overlapping copyWithin chunks (+ a fill fast-path for offset==1),
// which lets V8 memmove instead of stepping byte-by-byte.

export function uncompress(input: Buffer): Buffer {
  let ip = 0;
  // uncompressed length (varint)
  let outLen = 0,
    shift = 0;
  while (true) {
    const c = input[ip++];
    outLen += (c & 0x7f) * 2 ** shift;
    if (!(c & 0x80)) break;
    shift += 7;
  }

  const out = Buffer.allocUnsafe(outLen);
  let op = 0;

  while (ip < input.length) {
    const tag = input[ip++];
    const type = tag & 0x03;
    if (type === 0) {
      // literal
      let len = tag >> 2;
      if (len < 60) {
        len += 1;
      } else {
        const nbytes = len - 59;
        let l = 0;
        for (let i = 0; i < nbytes; i++) l += input[ip++] * 2 ** (8 * i);
        len = l + 1;
      }
      input.copy(out, op, ip, ip + len);
      ip += len;
      op += len;
    } else {
      let len: number, offset: number;
      if (type === 1) {
        len = ((tag >> 2) & 0x07) + 4;
        offset = ((tag >> 5) << 8) | input[ip++];
      } else if (type === 2) {
        len = (tag >> 2) + 1;
        offset = input[ip] | (input[ip + 1] << 8);
        ip += 2;
      } else {
        len = (tag >> 2) + 1;
        offset =
          (input[ip] | (input[ip + 1] << 8) | (input[ip + 2] << 16) | (input[ip + 3] << 24)) >>> 0;
        ip += 4;
      }
      const src = op - offset;
      if (offset === 1) {
        // run of a single byte — fill is far faster than a byte loop for long runs
        out.fill(out[src], op, op + len);
        op += len;
      } else {
        // Copy the already-written window forward in growing, non-overlapping chunks: each chunk
        // reads only bytes already produced (src+chunk <= op), so it reproduces the overlap
        // feed-forward exactly while letting each copyWithin be a plain memmove. When offset >= len
        // this is a single memmove; when offset < len the available run doubles per iteration.
        const end = op + len;
        while (op < end) {
          const chunk = Math.min(op - src, end - op);
          out.copyWithin(op, src, src + chunk);
          op += chunk;
        }
      }
    }
  }
  if (op !== outLen) throw new Error(`snappy: produced ${op} bytes, expected ${outLen}`);
  return out;
}
