// Data-free unit tests for the stable/pure layers — run in CI (no Teams cache needed).
// The integration suites (src/_inctest, _reusetest, _fbtest) need a real local cache and run
// locally via `npm run test:integration`.
import * as Snappy from '../src/format/chromium/snappy.js';
import { deserialize } from '../src/format/chromium/structured-clone.js';
import { crc32c } from '../src/format/chromium/sstable.js';
import { htmlToText, isSystemMessage, mentionedMris } from '../src/util/text.js';
import { makeHandle } from '../src/util/handles.js';
import { makeExtractor } from '../src/util/topics.js';
import { isBotMri } from '../src/ingest/store.js';
import { resolveEngine } from '../src/ingest/native.js';
import { discoverTeamsDbs } from '../src/format/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};
const eq = (n: string, a: unknown, b: unknown) =>
  ok(
    n,
    JSON.stringify(a) === JSON.stringify(b),
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`,
  );

console.log('=== snappy ===');
{
  // raw snappy: varint(len) + literal element. "hello" = [0x05, 0x10, h,e,l,l,o]
  const lit = Buffer.from([0x05, 0x10, 0x68, 0x65, 0x6c, 0x6c, 0x6f]);
  eq('literal block decompresses', Snappy.uncompress(lit).toString(), 'hello');
  // a 2-byte copy: "abcabc" — literal "abc" then copy offset 3 len 3.
  // len=3: varint 6; literal "abc": tag (2<<2)=0x08, bytes a,b,c; copy type2 len=(len-1<<2)|2=(2<<2)|2=0x0a, offset LE 3,0
  const cp = Buffer.from([0x06, 0x08, 0x61, 0x62, 0x63, 0x0a, 0x03, 0x00]);
  eq('overlapping copy decompresses', Snappy.uncompress(cp).toString(), 'abcabc');
}
{
  // Overlap-copy fidelity fixtures (offset < len) — the byte-feed-forward semantics that the A1
  // chunked-copy optimization must preserve exactly. Covers offset 1..4 < len, a long single-byte
  // run (fill fast-path), a non-overlapping copy (offset >= len → memmove path), and a long literal.
  const dec = (b: number[]) => Snappy.uncompress(Buffer.from(b)).toString();
  eq('overlap offset=1 len=5', dec([0x06, 0x00, 0x61, 0x05, 0x01]), 'aaaaaa');
  eq('overlap offset=2 len=5', dec([0x07, 0x04, 0x61, 0x62, 0x05, 0x02]), 'abababa');
  eq('overlap offset=3 len=8', dec([0x0b, 0x08, 0x61, 0x62, 0x63, 0x11, 0x03]), 'abcabcabcab');
  eq('overlap offset=4 len=6', dec([0x0a, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x09, 0x04]), 'abcdabcdab');
  eq(
    'non-overlap offset=4 len=4',
    dec([0x08, 0x0c, 0x61, 0x62, 0x63, 0x64, 0x01, 0x04]),
    'abcdabcd',
  );
  // offset=1 run of length 64 (2-byte copy tag) → exercises the fill() fast-path on a long run.
  eq('offset=1 run len=64', dec([0x41, 0x00, 0x61, 0xfe, 0x01, 0x00]), 'a'.repeat(65));
  // long literal (len-1 >= 60 → 1 extra length byte): 130 'z' bytes.
  const longLit = Buffer.concat([Buffer.from([0x82, 0x01, 0xf0, 0x81]), Buffer.alloc(130, 0x7a)]);
  eq('long literal 130B', Snappy.uncompress(longLit).toString(), 'z'.repeat(130));
}

console.log('=== htmlToText (A8 characterization — pins the tag/entity/whitespace transforms) ===');
{
  eq('br -> newline', htmlToText('a<br>b'), 'a\nb');
  eq('br self-closing -> newline', htmlToText('a<br/>b'), 'a\nb');
  eq('close-p -> newline', htmlToText('<p>x</p><p>y</p>'), 'x\ny');
  eq('div-open -> newline', htmlToText('<div>a</div><div>b</div>'), 'a\nb');
  eq('strip other tags', htmlToText('<span itemtype="x">Name</span>'), 'Name');
  eq('entity amp/lt', htmlToText('a&amp;b&lt;c'), 'a&b<c');
  eq('entity case-insensitive named', htmlToText('x&AMP;y'), 'x&y');
  eq('numeric decimal entity', htmlToText('&#65;&#66;'), 'AB');
  eq('numeric hex entity (lower+UPPER x)', htmlToText('&#x41;&#X42;'), 'AB');
  eq('accented named entity', htmlToText('gr&uuml;&szlig;e'), 'grüße');
  eq('unknown named entity -> space', htmlToText('a&bogus;b'), 'a b');
  eq('collapse spaces/tabs', htmlToText('a \t  b'), 'a b');
  eq('collapse blank lines', htmlToText('a<br><br><br><br>b'), 'a\n\nb');
  eq('entity inside stripped tag is gone', htmlToText('<a href="&amp;">t</a>'), 't');
  eq('combined', htmlToText('<div>Hi &amp; <b>bye</b></div>'), 'Hi & bye');
  eq('empty/nullish', htmlToText(''), '');
}

console.log('=== structured-clone (V8) ===');
{
  // {a:1}: FF 0F, 'o', '"' len1 'a', 'I' zigzag(1)=2, '{' count1
  const blob = Buffer.from([0xff, 0x0f, 0x6f, 0x22, 0x01, 0x61, 0x49, 0x02, 0x7b, 0x01]);
  eq('decodes {a:1}', deserialize(blob), { a: 1 });
  // {t:true, s:"hi"}
  const b2 = Buffer.from([
    0xff, 0x0f, 0x6f, 0x22, 0x01, 0x74, 0x54, 0x22, 0x01, 0x73, 0x22, 0x02, 0x68, 0x69, 0x7b, 0x02,
  ]);
  eq('decodes {t:true,s:"hi"}', deserialize(b2), { t: true, s: 'hi' });
}

console.log('=== crc32c ===');
{
  // standard test vector: CRC32C("123456789") = 0xE3069283
  eq('crc32c test vector', crc32c(Buffer.from('123456789'), 0, 9) >>> 0, 0xe3069283);
}

console.log('=== htmlToText ===');
{
  eq('strips tags + entities', htmlToText('<p>a &amp; b</p>'), 'a & b');
  eq('German named entity', htmlToText('Stra&szlig;e'), 'Straße');
  eq('hex entity', htmlToText('&#x41;bc'), 'Abc');
  ok(
    'control message is system',
    isSystemMessage({ type: 'Message', messageType: 'ThreadActivity/AddMember' }),
  );
  ok(
    'normal message is not system',
    !isSystemMessage({ type: 'Message', messageType: 'RichText/Html' }),
  );
  eq('mentions parsed from JSON string', mentionedMris('[{"mri":"8:orgid:x"}]'), ['8:orgid:x']);
}

console.log('=== handles ===');
{
  const h = makeHandle('c', 'some-id', 6);
  ok('handle format', /^c:[0-9a-f]{6}$/.test(h));
  eq('handle deterministic', makeHandle('c', 'some-id', 6), h);
  ok('different ids differ', makeHandle('p', 'a', 6) !== makeHandle('p', 'b', 6));
}

console.log('=== bot classification ===');
{
  ok('28: is a bot', isBotMri('28:512b84d2-abc'));
  ok('8:orgid: is not', !isBotMri('8:orgid:guid'));
  ok('null is not', !isBotMri(null));
}

console.log('=== topic extraction ===');
{
  const { phrases } = makeExtractor(new Set());
  const p = phrases('the exam review is cancelled');
  ok('keeps content phrase', p.includes('exam review'));
  ok('drops stopwords', !p.includes('the') && !p.includes('is'));
  const de = makeExtractor(new Set()).phrases('das seminar ist abgesagt');
  ok('drops German stopwords (das/ist)', !de.includes('das') && !de.includes('ist'));
}

// parseTime lives in the MCP layer (zaungast/tools) → its test moved to packages/zaungast/test/unit.ts
// (a libzaungast test must not depend on zaungast).

console.log('\n=== discoverTeamsDbs: platform layouts (Windows + macOS) ===');
{
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
  ok(
    'macOS: auto-discovers the container leveldb store',
    mac.length === 1 && mac[0].dir === macStore,
    JSON.stringify(mac),
  );
  ok('macOS: profile parsed', mac[0]?.profile === 'WV2Profile_tfw');

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
  ok(
    'Windows: auto-discovers the package leveldb store',
    win.length === 1 && win[0].dir === winStore,
    JSON.stringify(win),
  );

  // negative: wrong platform for the tree finds nothing (no false positives)
  const none = discoverTeamsDbs({}, { platform: 'darwin', home: winHome });
  ok('macOS discovery does not match a Windows tree', none.length === 0);

  fs.rmSync(macHome, { recursive: true, force: true });
  fs.rmSync(winHome, { recursive: true, force: true });
}

console.log('\n=== engine resolution (default js; explicit + env opt-in) ===');
{
  const saved = process.env.ZAUNGAST_ENGINE;
  delete process.env.ZAUNGAST_ENGINE;
  eq("default engine is 'js' (native is opt-in only)", resolveEngine(), 'js');
  eq("explicit 'auto' is respected", resolveEngine('auto'), 'auto');
  eq("explicit 'native' is respected", resolveEngine('native'), 'native');
  process.env.ZAUNGAST_ENGINE = 'native';
  eq('ZAUNGAST_ENGINE overrides the option', resolveEngine('js'), 'native');
  process.env.ZAUNGAST_ENGINE = 'bogus';
  eq('unknown ZAUNGAST_ENGINE is ignored → option', resolveEngine('auto'), 'auto');
  if (saved === undefined) delete process.env.ZAUNGAST_ENGINE;
  else process.env.ZAUNGAST_ENGINE = saved;
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
