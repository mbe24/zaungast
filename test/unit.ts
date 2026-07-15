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
import { parseTime } from '../src/tools.js';

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

console.log('=== parseTime future/past relatives ===');
{
  const now = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15T12:00:00Z, fixed
  eq('+7d is 7 days in the future', parseTime('+7d', now), now + 7 * 864e5);
  eq('-7d is 7 days in the past', parseTime('-7d', now), now - 7 * 864e5);
  eq('+24h is 24 hours in the future', parseTime('+24h', now), now + 24 * 36e5);
  eq('-24h is 24 hours in the past', parseTime('-24h', now), now - 24 * 36e5);
  eq('+30m is 30 minutes in the future', parseTime('+30m', now), now + 30 * 6e4);
  ok('ISO date still parses', parseTime('2026-07-01') === Date.parse('2026-07-01'));
  ok('bare epoch number still parses', parseTime(12345) === 12345);
  ok('garbage is undefined', parseTime('not-a-date') === undefined);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
