// The byte-codec contract: the handful of `Buffer` operations the decode core needs, as an
// environment-agnostic interface over `Uint8Array`. Two implementations satisfy it, selected by the
// `#bytes` conditional import (see package.json `imports`):
//   • bytes-node.ts — delegates to the native `Buffer` builtin (the MCP's hot path; native-speed strings).
//   • bytes-web.ts  — hand-rolled, dependency-free (the browser build).
// `TextDecoder` is deliberately NOT used for latin1/utf16le: WHATWG aliases 'latin1'/'iso-8859-1' to
// windows-1252 and sanitizes lone surrogates, which would silently corrupt keys/values (green on Node,
// wrong in the browser). Only utf-8 is decoded via `TextDecoder` (with `ignoreBOM`). See plan A2/§4.
export interface BytesCodec {
  /** Latin-1 (ISO-8859-1, 1:1 byte↔codepoint) decode of `u8[start..end)`. */
  toLatin1(u8: Uint8Array, start?: number, end?: number): string;
  /** Latin-1 encode: each char's low byte. Exact inverse of `toLatin1` for byte-strings. */
  fromLatin1(s: string): Uint8Array;
  /** Lowercase hex of every byte. */
  toHex(u8: Uint8Array): string;
  /** UTF-8 decode of `u8[start..end)`, BOM preserved (matches `Buffer.toString('utf8')`). */
  toUtf8(u8: Uint8Array, start?: number, end?: number): string;
  /** UTF-16LE decode of `u8[start..end)`, raw: BOM + lone surrogates kept, trailing odd byte dropped. */
  toUtf16le(u8: Uint8Array, start?: number, end?: number): string;
  /** An UNINITIALIZED buffer of length `n` (every caller fully populates it — like `allocUnsafe`). */
  alloc(n: number): Uint8Array;
  /** Concatenate `parts` into one buffer. */
  concat(parts: Uint8Array[]): Uint8Array;
}
