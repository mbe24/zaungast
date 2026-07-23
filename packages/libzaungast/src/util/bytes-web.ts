// Web byte codec — hand-rolled, zero dependencies, no `Buffer`. latin1 + utf16le are done by hand
// because WHATWG `TextDecoder` aliases their labels to windows-1252 and sanitizes lone surrogates (both
// silently corrupt data — see bytes-types.ts). Only utf-8 uses `TextDecoder`, the one decode WHATWG gets
// right, with `ignoreBOM` so a leading BOM is preserved (matching `Buffer.toString('utf8')`). Selected
// via `#bytes` under the `browser` condition. Correctness is pinned against the Node codec by
// test/bytes.unit.ts; this path is not perf-critical (it's the browser demo, not the MCP hot path).
import type { BytesCodec } from './bytes-types.js';

const CHUNK = 8192; // bound spread arg-count for fromCharCode on large inputs

export const toLatin1: BytesCodec['toLatin1'] = (u8, start = 0, end = u8.length) => {
  let s = '';
  for (let i = start; i < end; i += CHUNK)
    s += String.fromCharCode(...u8.subarray(i, Math.min(i + CHUNK, end)));
  return s;
};

export const fromLatin1: BytesCodec['fromLatin1'] = (s) => {
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
  return u8;
};

const HEX = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, '0'));
export const toHex: BytesCodec['toHex'] = (u8) => {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += HEX[u8[i]];
  return s;
};

const UTF8 = new TextDecoder('utf-8', { ignoreBOM: true });
export const toUtf8: BytesCodec['toUtf8'] = (u8, start = 0, end = u8.length) =>
  UTF8.decode(u8.subarray(start, end));

export const toUtf16le: BytesCodec['toUtf16le'] = (u8, start = 0, end = u8.length) => {
  const units: number[] = [];
  for (let i = start; i + 1 < end; i += 2) units.push(u8[i] | (u8[i + 1] << 8));
  // A trailing odd byte is dropped, matching Buffer.toString('utf16le') (no U+FFFD).
  let s = '';
  for (let i = 0; i < units.length; i += CHUNK)
    s += String.fromCharCode(...units.slice(i, i + CHUNK));
  return s;
};

export const alloc: BytesCodec['alloc'] = (n) => new Uint8Array(n);

export const concat: BytesCodec['concat'] = (parts) => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};
