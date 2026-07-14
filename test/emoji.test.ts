// Unit tests for src/util/emoji.ts (reactionGlyph). Data-free, pure-function tests — run in CI.
// The KEY_INVENTORY table below is a literal copy of the 117 distinct Teams reaction keys seen in
// a real (PII-free) cache, with usage counts, used to assert full coverage and report the
// glyph-vs-fallback split by both key count and usage share.
// Run: node --import tsx test/emoji.test.ts
import { reactionGlyph } from '../src/util/emoji.js';

let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};
const eq = (name: string, a: unknown, b: unknown): void =>
  ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// A codepoint outside the ASCII range signals a real emoji glyph resolved (as opposed to a
// cleaned-up text fallback, which is always plain ASCII/identifier characters in this inventory).
const isGlyph = (s: string): boolean => [...s].some((ch) => ch.codePointAt(0)! > 127);

console.log('=== codepoint-prefix ===');
eq('single codepoint prefix', reactionGlyph('1f389_partypopper'), '🎉');
eq('single codepoint prefix 2', reactionGlyph('2705_whiteheavycheckmark'), '✅');

console.log('\n=== classic shortcode table ===');
eq('like', reactionGlyph('like'), '👍');

console.log('\n=== skin-tone suffix stripped before lookup ===');
eq(
  'fistbump-tone2 resolves same as fistbump',
  reactionGlyph('fistbump-tone2'),
  reactionGlyph('fistbump'),
);
ok('fistbump-tone2 is a real glyph', isGlyph(reactionGlyph('fistbump-tone2')));

console.log('\n=== org-custom tail stripped before lookup ===');
eq('plusone;0-weu-abc', reactionGlyph('plusone;0-weu-abc'), '👍');

console.log('\n=== edge cases ===');
eq('empty key returns original (empty) key', reactionGlyph(''), '');
ok(
  'never throws on garbage input',
  (() => {
    try {
      reactionGlyph('___;;;-tone9');
      reactionGlyph('_');
      reactionGlyph(';');
      return true;
    } catch {
      return false;
    }
  })(),
);

// ---- full real-world inventory: every key must resolve to a non-empty string, never throw ----
// count / key, taken verbatim from a real (PII-free) Teams reaction-key inventory (117 keys).
const KEY_INVENTORY: Array<[number, string]> = [
  [1927, 'like'],
  [413, 'laugh'],
  [349, 'heart'],
  [93, '1f389_partypopper'],
  [56, 'praying'],
  [47, 'surprised'],
  [29, '1f440_eyes'],
  [22, 'yes-tone2'],
  [21, 'cake'],
  [16, '1f4af_hundredpointssymbol'],
  [15, 'think'],
  [13, 'sweatgrinning'],
  [13, 'handsinair'],
  [12, 'launch'],
  [11, 'party'],
  [10, 'champagne'],
  [8, '2705_whiteheavycheckmark'],
  [8, 'screamingfear'],
  [7, 'fistbump-tone2'],
  [7, 'poop'],
  [7, 'fire'],
  [7, 'fistbump'],
  [6, 'smile'],
  [5, 'crossedfingers'],
  [5, 'cry'],
  [5, 'cakeslice'],
  [4, 'grinningfacewithsmilingeyes'],
  [4, 'yes-tone1'],
  [4, 'smilingfacewithtear'],
  [4, 'plusone;0-weu-d16-7deeffeb98b40f8597b982cfce22c12e'],
  [4, 'sun'],
  [4, '1f4a1_electriclightbulb'],
  [3, '1f601_beamingfacewithsmilingeyes'],
  [3, 'cwl'],
  [3, 'stareyes'],
  [3, '2714_heavycheckmark'],
  [3, 'hearteyes'],
  [3, 'upsidedownface'],
  [3, '1f941_drumwithdrumsticks'],
  [3, 'yes-tone4'],
  [3, '1f310_globewithmeridians'],
  [2, 'diamond'],
  [2, '50th_chess'],
  [2, 'rock'],
  [2, 'cool'],
  [2, 'veryconfused'],
  [2, '1f4ce_paperclip'],
  [2, 'smilerobot'],
  [2, 'seenoevil'],
  [2, 'ok'],
  [2, '1f97a_pleadingface'],
  [2, 'salute'],
  [2, 'personrunningfacingright2'],
  [2, 'womanshrug'],
  [2, 'goldmedal'],
  [2, 'starMSER'],
  [2, 'expressionless'],
  [2, '1f92a_zanyface'],
  [2, '1f3a2_rollercoaster'],
  [2, '2795_heavyplussign'],
  [2, '1f4b5_banknotewithdollarsign'],
  [2, 'palmtree'],
  [2, 'yes-tone3'],
  [2, 'clappinghands'],
  [2, '1f926_personfacepalming'],
  [1, 'relieved'],
  [1, 'man_pouting'],
  [1, 'crossedfingers-tone2'],
  [1, 'angel'],
  [1, 'confused'],
  [1, '1f4ab_dizzysymbol'],
  [1, 'shrug'],
  [1, 'wasntme'],
  [1, '1f51c_soon'],
  [1, 'muscle'],
  [1, '1f62c_grimacingface'],
  [1, 'climber'],
  [1, 'gift'],
  [1, 'holdon'],
  [1, '23f2_timerclock'],
  [1, '1f922_nauseatedface'],
  [1, '1f33f_herb'],
  [1, '1f6a8_policecarsrevolvinglight'],
  [1, 'nerdy'],
  [1, '1f37b_clinkingbeermugs'],
  [1, 'trophy'],
  [1, '2195_updownarrow'],
  [1, '1f4a5_collisionsymbol'],
  [1, 'pizzaslice'],
  [1, '1f954_potato'],
  [1, 'maracas'],
  [1, 'happyface'],
  [1, 'cash'],
  [1, 'unicornhead'],
  [1, 'sparklingheart'],
  [1, '1f4b0_moneybag'],
  [1, 'lipssealed'],
  [1, '1f68c_bus'],
  [1, '1f192_squaredcool'],
  [1, 'lotus_position'],
  [1, '1f197_squaredok'],
  [1, 'music'],
  [1, 'penguin'],
  [1, 'womanhealthworker'],
  [1, 'manshrug'],
  [1, 'shivering'],
  [1, '2728_sparkles'],
  [1, 'hearteyesrobot'],
  [1, 'cookies'],
  [1, 'speechbubble'],
  [1, 'wink'],
  [1, 'sweat'],
  [1, '203c_doubleexclamationmark'],
  [1, 'likeWithFaceMSER'],
  [1, '2753_blackquestionmarkornament'],
  [1, 'headshakingvertically2'],
  [1, '1f41e_ladybeetle'],
];

console.log(`\n=== full inventory (${KEY_INVENTORY.length} keys) ===`);
let glyphKeys = 0,
  fallbackKeys = 0;
let glyphUsage = 0,
  fallbackUsage = 0;
const fallbacks: Array<[number, string]> = [];
for (const [count, key] of KEY_INVENTORY) {
  let result = '';
  let threw = false;
  try {
    result = reactionGlyph(key);
  } catch {
    threw = true;
  }
  ok(`no throw: ${key}`, !threw);
  ok(`non-empty: ${key}`, result.length > 0, `got ${JSON.stringify(result)}`);
  if (isGlyph(result)) {
    glyphKeys++;
    glyphUsage += count;
  } else {
    fallbackKeys++;
    fallbackUsage += count;
    fallbacks.push([count, key]);
  }
}

const totalKeys = KEY_INVENTORY.length;
const totalUsage = KEY_INVENTORY.reduce((n, [c]) => n + c, 0);
console.log('\n=== coverage summary ===');
console.log(
  `  by key count:  ${glyphKeys}/${totalKeys} resolved to a glyph (${((glyphKeys / totalKeys) * 100).toFixed(1)}%), ${fallbackKeys} fell back to text`,
);
console.log(
  `  by usage share: ${glyphUsage}/${totalUsage} reaction instances got a glyph (${((glyphUsage / totalUsage) * 100).toFixed(1)}%), ${fallbackUsage} fell back to text`,
);
console.log('  fallback keys (deliberately unmapped):');
for (const [count, key] of fallbacks.sort((a, b) => b[0] - a[0]))
  console.log(`    ${key} (used ${count}x) -> "${reactionGlyph(key)}"`);

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
