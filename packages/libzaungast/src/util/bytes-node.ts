// Node byte codec — delegates to the native `Buffer` builtin (not an npm dependency). Every runtime
// buffer in the decode path originates as a `Buffer` (`fs.readFileSync` / `alloc`), so `asBuf` is a
// no-op there and the string codecs run at native speed (the reason we don't hand-roll on Node; the
// hand-rolled latin1 is 13–40× slower at content sizes — see plan §3). Selected via `#bytes` on Node.
import { Buffer } from 'node:buffer';
import type { BytesCodec } from './bytes-types.js';

// A Buffer VIEW over the same memory (no copy) when the input isn't already a Buffer (e.g. under test).
const asBuf = (u8: Uint8Array): Buffer =>
  Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

export const toLatin1: BytesCodec['toLatin1'] = (u8, start, end) =>
  asBuf(u8).toString('latin1', start, end);
export const fromLatin1: BytesCodec['fromLatin1'] = (s) => Buffer.from(s, 'latin1');
export const toHex: BytesCodec['toHex'] = (u8) => asBuf(u8).toString('hex');
export const toUtf8: BytesCodec['toUtf8'] = (u8, start, end) =>
  asBuf(u8).toString('utf8', start, end);
export const toUtf16le: BytesCodec['toUtf16le'] = (u8, start, end) =>
  asBuf(u8).toString('utf16le', start, end);
export const alloc: BytesCodec['alloc'] = (n) => Buffer.allocUnsafe(n);
export const concat: BytesCodec['concat'] = (parts) => Buffer.concat(parts);
