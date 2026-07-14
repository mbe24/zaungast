// Snappy raw-block decompressor (not the framed format).
// Format: varint uncompressed-length, then a stream of elements:
//   tag&3 == 0  literal:      len-1 in tag>>2 (or, if >=60, in the next (val-59) LE bytes)
//   tag&3 == 1  copy 1-byte:  len = ((tag>>2)&7)+4 ; offset = ((tag>>5)<<8) | next byte
//   tag&3 == 2  copy 2-byte:  len = (tag>>2)+1     ; offset = next 2 bytes LE
//   tag&3 == 3  copy 4-byte:  len = (tag>>2)+1     ; offset = next 4 bytes LE
// Copies may overlap (offset < len) → must copy byte-by-byte.

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
      let src = op - offset;
      for (let i = 0; i < len; i++) out[op++] = out[src++]; // byte-by-byte (handles overlap)
    }
  }
  if (op !== outLen) throw new Error(`snappy: produced ${op} bytes, expected ${outLen}`);
  return out;
}
