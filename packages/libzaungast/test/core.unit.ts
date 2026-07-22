// Data-free unit tests for the stable/pure layers — run in CI (no Teams cache needed).
// The integration suites (incremental.int, reuse.int, feedback.int) need a real local cache and run
// locally via `npm run test:integration`.
import { test, expect } from 'vitest';
import * as Snappy from '../src/format/chromium/snappy.js';
import { deserialize } from '../src/format/chromium/structured-clone.js';
import { crc32c } from '../src/format/chromium/sstable.js';
import { htmlToText, isSystemMessage, mentionedMris } from '../src/util/text.js';
import { makeHandle } from '../src/util/handles.js';
import { makeExtractor } from '../src/util/topics.js';
import { isBotMri } from '../src/ingest/store.js';
import { discoverTeamsDbs } from '../src/format/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Run: npx vitest run packages/libzaungast/test/core.unit.ts

test('snappy', () => {
  // raw snappy: varint(len) + literal element. "hello" = [0x05, 0x10, h,e,l,l,o]
  const lit = Buffer.from([0x05, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  expect(Snappy.uncompress(lit).toString()).toEqual('hello');
  // a 2-byte copy: "abcabc" — literal "abc" then copy offset 3 len 3.
  // len=3: varint 6; literal "abc": tag (2<<2)=0x08, bytes a,b,c; copy type2 len=(len-1<<2)|2=(2<<2)|2=0x0a, offset LE 3,0
  const cp = Buffer.from([0x06, 0x08, 0x61, 0x62, 0x63, 0x0a, 0x03, 0x00]);
  expect(Snappy.uncompress(cp).toString()).toEqual('abcabc');

  // Overlap-copy fidelity fixtures (offset < len) — the byte-feed-forward semantics that the
  // chunked-copy optimization must preserve exactly. Covers offset 1..4 < len, a long single-byte
  // run (fill fast-path), a non-overlapping copy (offset >= len → memmove path), and a long literal.
  const dec = (b: number[]) => Snappy.uncompress(Buffer.from(b)).toString();
  expect(dec([0x06, 0x00, 0x61, 0x05, 0x01])).toEqual('aaaaaa');
  expect(dec([0x07, 0x04, 0x61, 0x62, 0x05, 0x02])).toEqual('abababa');
  expect(dec([0x0b, 0x08, 0x61, 0x62, 0x63, 0x11, 0x03])).toEqual('abcabcabcab');
  expect(dec([0x0a, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x09, 0x04])).toEqual('abcdabcdab');
  expect(dec([0x08, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x01, 0x04])).toEqual('abcdabcd');
  // offset=1 run of length 64 (2-byte copy tag) → exercises the fill() fast-path on a long run.
  expect(dec([0x41, 0x00, 0x61, 0xfe, 0x01, 0x00])).toEqual('a'.repeat(65));
  // long literal (len-1 >= 60 → 1 extra length byte): 130 'z' bytes.
  const longLit = Buffer.concat([Buffer.from([0x82, 0x01, 0xf0, 0x81]), Buffer.alloc(130, 0x7a)]);
  expect(Snappy.uncompress(longLit).toString()).toEqual('z'.repeat(130));
});

test('htmlToText (characterization — pins the tag/entity/whitespace transforms)', () => {
  expect(htmlToText('a<br>b')).toEqual('a\nb');
  expect(htmlToText('a<br/>b')).toEqual('a\nb');
  expect(htmlToText('<p>x</p><p>y</p>')).toEqual('x\ny');
  expect(htmlToText('<div>a</div><div>b</div>')).toEqual('a\nb');
  expect(htmlToText('<span itemtype="x">Name</span>')).toEqual('Name');
  expect(htmlToText('a&amp;b&lt;c')).toEqual('a&b<c');
  expect(htmlToText('x&AMP;y')).toEqual('x&y');
  expect(htmlToText('&#65;&#66;')).toEqual('AB');
  expect(htmlToText('&#x41;&#X42;')).toEqual('AB');
  expect(htmlToText('gr&uuml;&szlig;e')).toEqual('grüße');
  expect(htmlToText('a&bogus;b')).toEqual('a b');
  expect(htmlToText('a \t  b')).toEqual('a b');
  expect(htmlToText('a<br><br><br><br>b')).toEqual('a\n\nb');
  expect(htmlToText('<a href="&amp;">t</a>')).toEqual('t');
  expect(htmlToText('<div>Hi &amp; <b>bye</b></div>')).toEqual('Hi & bye');
  expect(htmlToText('')).toEqual('');
});

test('structured-clone (V8)', () => {
  // {a:1}: FF 0F, 'o', '"' len1 'a', 'I' zigzag(1)=2, '{' count1
  const blob = Buffer.from([0xff, 0x0f, 0x6f, 0x22, 0x01, 0x61, 0x49, 0x02, 0x7b, 0x01]);
  expect(deserialize(blob)).toEqual({ a: 1 });
  // {t:true, s:"hi"}
  const b2 = Buffer.from([
    0xff, 0x0f, 0x6f, 0x22, 0x01, 0x74, 0x54, 0x22, 0x01, 0x73, 0x22, 0x02, 0x68, 0x69, 0x7b, 0x02,
  ]);
  expect(deserialize(b2)).toEqual({ t: true, s: 'hi' });
});

test('crc32c', () => {
  // standard test vector: CRC32C("123456789") = 0xE3069283
  expect(crc32c(Buffer.from('123456789'), 0, 9) >>> 0).toEqual(0xe3069283);
});

test('htmlToText', () => {
  expect(htmlToText('<p>a &amp; b</p>')).toEqual('a & b');
  expect(htmlToText('Stra&szlig;e')).toEqual('Straße');
  expect(htmlToText('&#x41;bc')).toEqual('Abc');
  expect(
    isSystemMessage({ type: 'Message', messageType: 'ThreadActivity/AddMember' }),
    'control message is system',
  ).toBe(true);
  expect(
    !isSystemMessage({ type: 'Message', messageType: 'RichText/Html' }),
    'normal message is not system',
  ).toBe(true);
  expect(mentionedMris('[{"mri":"8:orgid:x"}]')).toEqual(['8:orgid:x']);
});

test('handles', () => {
  const h = makeHandle('c', 'some-id', 6);
  expect(/^c:[0-9a-f]{6}$/.test(h), 'handle format').toBe(true);
  expect(makeHandle('c', 'some-id', 6)).toEqual(h);
  expect(makeHandle('p', 'a', 6) !== makeHandle('p', 'b', 6), 'different ids differ').toBe(true);
});

test('bot classification', () => {
  expect(isBotMri('28:512b84d2-abc'), '28: is a bot').toBe(true);
  expect(!isBotMri('8:orgid:guid'), '8:orgid: is not').toBe(true);
  expect(!isBotMri(null), 'null is not').toBe(true);
});

test('topic extraction', () => {
  const { phrases } = makeExtractor(new Set());
  const p = phrases('the exam review is cancelled');
  expect(p.includes('exam review'), 'keeps content phrase').toBe(true);
  expect(!p.includes('the') && !p.includes('is'), 'drops stopwords').toBe(true);
  const de = makeExtractor(new Set()).phrases('das seminar ist abgesagt');
  expect(!de.includes('das') && !de.includes('ist'), 'drops German stopwords (das/ist)').toBe(true);
});

// parseTime lives in the MCP layer (zaungast/tools) → its test is packages/zaungast/test/parse-time.unit.ts
// (a libzaungast test must not depend on zaungast).

test('discoverTeamsDbs: platform layouts (Windows + macOS)', () => {
  // Build a fake leveldb store under a given profile path and return the store dir.
  const makeStore = (profileDir: string): string => {
    const store = path.join(
      profileDir,
      'IndexedDB',
      'https_teams.microsoft.com_0.indexeddb.leveldb',
    );
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(store, 'CURRENT'), 'MANIFEST-000001\n');
    fs.writeFileSync(path.join(store, 'MANIFEST-000001'), 'x');
    return store;
  };
  // macOS: ~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/
  //        MSTeams/EBWebView/WV2Profile_tfw/IndexedDB/…leveldb  (the colleague's observed path)
  const macHome = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-mac-'));
  const macStore = makeStore(
    path.join(
      macHome,
      'Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/EBWebView/WV2Profile_tfw',
    ),
  );
  const mac = discoverTeamsDbs({}, { platform: 'darwin', home: macHome });
  expect(mac.length === 1 && mac[0].dir === macStore, JSON.stringify(mac)).toBe(true);
  expect(mac[0]?.profile === 'WV2Profile_tfw', 'macOS: profile parsed').toBe(true);

  // Windows: %LOCALAPPDATA%\Packages\MSTeams_*\LocalCache\Microsoft\MSTeams\EBWebView\<profile>\…
  const winHome = fs.mkdtempSync(path.join(os.tmpdir(), 'disc-win-'));
  const localAppData = path.join(winHome, 'AppData', 'Local');
  const winStore = makeStore(
    path.join(
      localAppData,
      'Packages/MSTeams_8wekyb3d8bbwe/LocalCache/Microsoft/MSTeams/EBWebView/WV2Profile_tfw',
    ),
  );
  const win = discoverTeamsDbs({}, { platform: 'win32', home: winHome, localAppData });
  expect(win.length === 1 && win[0].dir === winStore, JSON.stringify(win)).toBe(true);

  // negative: wrong platform for the tree finds nothing (no false positives)
  const none = discoverTeamsDbs({}, { platform: 'darwin', home: winHome });
  expect(none.length === 0, 'macOS discovery does not match a Windows tree').toBe(true);

  fs.rmSync(macHome, { recursive: true, force: true });
  fs.rmSync(winHome, { recursive: true, force: true });
});
