// Teams reaction shortcode -> emoji glyph. Reactions come back from the store as raw keys like
// `1f389_partypopper`, `plusone;0-weu-<hash>`, `fistbump-tone2`, or a bare named shortcode.
// Resolution order: strip skin-tone suffix -> strip org-custom tail -> codepoint prefix ->
// shortcode table -> cleaned fallback (never the raw ugly key, never empty, never throws).

const TONE_SUFFIX = /-tone[1-6]$/;
// A leading run of 4-6 hex digits followed by `_` is a Unicode codepoint (e.g. `1f389_partypopper`,
// hex before the `_`, human-readable name after). Some keys are ZWJ sequences with every chunk hex
// (e.g. `1f469_200d_1f4bb`) — handled below by checking whether ALL chunks parse as hex.
const HEX_CHUNK = /^[0-9a-fA-F]{4,6}$/;

const SHORTCODES: Record<string, string> = {
  // classic reaction set
  like: '👍',
  plusone: '👍',
  heart: '❤️',
  love: '😍',
  laugh: '😂',
  smile: '😊',
  happyface: '😊',
  sad: '😢',
  cry: '😢',
  angry: '😠',
  surprised: '😮',
  wow: '😲',
  yes: '✅',
  check: '✅',
  no: '❌',
  clap: '👏',
  clappinghands: '👏',
  fire: '🔥',
  praying: '🙏',
  tada: '🎉',
  party: '🎉',
  rocket: '🚀',
  launch: '🚀',
  eyes: '👀',
  thinking: '🤔',
  think: '🤔',

  // real inventory: named tail (highest-usage keys prioritized)
  sweatgrinning: '😅',
  handsinair: '🙌',
  champagne: '🍾',
  screamingfear: '😱',
  poop: '💩',
  fistbump: '👊',
  crossedfingers: '🤞',
  cake: '🍰',
  cakeslice: '🍰',
  grinningfacewithsmilingeyes: '😄',
  smilingfacewithtear: '🥲',
  sun: '☀️',
  stareyes: '🤩',
  hearteyes: '😍',
  upsidedownface: '🙃',
  diamond: '💎',
  rock: '🤘',
  cool: '😎',
  veryconfused: '😕',
  seenoevil: '🙈',
  ok: '👌',
  salute: '🫡',
  personrunningfacingright: '🏃',
  personrunningfacingright2: '🏃',
  womanshrug: '🤷‍♀️',
  manshrug: '🤷‍♂️',
  shrug: '🤷',
  goldmedal: '🥇',
  expressionless: '😑',
  palmtree: '🌴',
  relieved: '😌',
  man_pouting: '🙎‍♂️',
  angel: '😇',
  confused: '😕',
  muscle: '💪',
  climber: '🧗',
  gift: '🎁',
  nerdy: '🤓',
  trophy: '🏆',
  pizzaslice: '🍕',
  maracas: '🪇',
  cash: '💵',
  unicornhead: '🦄',
  sparklingheart: '💖',
  lipssealed: '🤐',
  lotus_position: '🧘',
  music: '🎵',
  penguin: '🐧',
  womanhealthworker: '👩‍⚕️',
  shivering: '🥶',
  cookies: '🍪',
  speechbubble: '💬',
  wink: '😉',
  sweat: '😓',

  // deliberately NOT included (fall through to text fallback below), see reactionGlyph doc:
  // cwl, cvl, 50th_chess, starMSER, smilerobot, wasntme, holdon, hearteyesrobot,
  // likeWithFaceMSER, headshakingvertically2
};

export function reactionGlyph(key: string): string {
  if (!key) return key;

  let k = key.replace(TONE_SUFFIX, '');
  const semi = k.indexOf(';');
  if (semi >= 0) k = k.slice(0, semi);
  if (!k) return key;

  const chunks = k.split('_');
  if (HEX_CHUNK.test(chunks[0])) {
    const allHex = chunks.length > 1 && chunks.every((c) => HEX_CHUNK.test(c));
    try {
      if (allHex) return chunks.map((c) => String.fromCodePoint(parseInt(c, 16))).join('');
      return String.fromCodePoint(parseInt(chunks[0], 16));
    } catch {
      // malformed codepoint — fall through to table/fallback below
    }
  }

  const glyph = SHORTCODES[k] ?? SHORTCODES[k.toLowerCase()];
  if (glyph) return glyph;

  return k;
}
