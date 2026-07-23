// Codec test vector — the guard against the "green on Node, corrupt in the browser" class (WHATWG
// TextDecoder would mangle latin1/utf16le). Runs both implementations through the same vector on Node,
// asserts they agree, and pins the tricky raw-vs-sanitized cases. The happy-dom project (plan A8) runs
// this same spec under the browser condition, where `#bytes` resolves to the web impl.
import { test, expect } from 'vitest';
import type { BytesCodec } from '../src/util/bytes-types.js';
import * as node from '../src/util/bytes-node.js';
import * as web from '../src/util/bytes-web.js';
import * as viaImport from '#bytes';

// Typing the tuple as [_, BytesCodec] forces both impls to satisfy the contract at compile time.
const impls: ReadonlyArray<readonly [string, BytesCodec]> = [
  ['node', node],
  ['web', web],
];

// #bytes resolution is condition-dependent: the default (Node) projects resolve the node impl; the
// happy-dom `browser` project (plan A8, conditions:['browser']) resolves the web impl. happy-dom sets a
// global `window`, so assert the environment-appropriate impl either way — this proves BOTH branches of
// the imports map resolve to a real codec (and that the browser project's condition actually took).
const inBrowserCondition = typeof (globalThis as { window?: unknown }).window !== 'undefined';
test('#bytes resolves to the impl matching the active condition (node vs browser)', () => {
  expect(viaImport.toHex).toBe(inBrowserCondition ? web.toHex : node.toHex);
});

test.each(impls)('%s: latin1 round-trips all 256 byte values (1:1, not windows-1252)', (_n, c) => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  const s = c.toLatin1(all);
  expect(s.length).toBe(256);
  for (let i = 0; i < 256; i++) expect(s.charCodeAt(i)).toBe(i);
  expect([...c.fromLatin1(s)]).toEqual([...all]);
});

test.each(impls)('%s: latin1 honors start/end', (_n, c) => {
  const u8 = Uint8Array.from([0x41, 0x80, 0x92, 0xff, 0x00]);
  expect(c.toLatin1(u8, 1, 4)).toBe('ÿ');
});

test.each(impls)('%s: hex', (_n, c) => {
  expect(c.toHex(Uint8Array.from([0x00, 0x0f, 0xa0, 0xff]))).toBe('000fa0ff');
});

test.each(impls)('%s: utf-8 preserves a leading BOM', (_n, c) => {
  expect(c.toUtf8(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('﻿hi');
});

test.each(impls)(
  '%s: utf16le is raw — BOM + lone surrogate kept, odd trailing byte dropped',
  (_n, c) => {
    // FF FE (BOM) · 3D D8 (lone high surrogate U+D83D) · 41 00 ('A') · 42 (odd trailing byte)
    const bytes = Uint8Array.from([0xff, 0xfe, 0x3d, 0xd8, 0x41, 0x00, 0x42]);
    const s = c.toUtf16le(bytes);
    expect(s.length).toBe(3);
    expect(s.charCodeAt(0)).toBe(0xfeff);
    expect(s.charCodeAt(1)).toBe(0xd83d);
    expect(s.charCodeAt(2)).toBe(0x41);
  },
);

test.each(impls)('%s: alloc (uninitialized, caller-filled) + concat', (_n, c) => {
  const a = c.alloc(3);
  a.set([1, 2, 3]);
  expect([...c.concat([a, Uint8Array.from([4, 5])])]).toEqual([1, 2, 3, 4, 5]);
  expect(c.alloc(0).length).toBe(0);
});

test('node and web agree on a mixed vector', () => {
  const v = Uint8Array.from([0x00, 0x41, 0x80, 0x92, 0xff, 0xef, 0xbb, 0xbf, 0x3d, 0xd8, 0x61]);
  expect(web.toLatin1(v)).toBe(node.toLatin1(v));
  expect(web.toHex(v)).toBe(node.toHex(v));
  expect(web.toUtf16le(v)).toBe(node.toUtf16le(v));
  expect(web.toUtf8(Uint8Array.from([0x68, 0xc3, 0xa9]))).toBe(
    node.toUtf8(Uint8Array.from([0x68, 0xc3, 0xa9])),
  );
  expect([...web.fromLatin1('Aÿ')]).toEqual([...node.fromLatin1('Aÿ')]);
});
