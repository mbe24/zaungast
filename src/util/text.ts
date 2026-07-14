// HTML message content → clean plain text, preserving @mentions as text.
// Teams mentions are <span itemtype="http://schema.skype.com/Mention">Name</span> — the
// inner text (the name) survives tag-stripping, which is what we want for search/topics.

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  // common named entities so accented text (German/French/…) isn't mangled to spaces
  '&auml;': 'ä',
  '&ouml;': 'ö',
  '&uuml;': 'ü',
  '&szlig;': 'ß',
  '&Auml;': 'Ä',
  '&Ouml;': 'Ö',
  '&Uuml;': 'Ü',
  '&eacute;': 'é',
  '&egrave;': 'è',
  '&ecirc;': 'ê',
  '&agrave;': 'à',
  '&acirc;': 'â',
  '&ccedil;': 'ç',
  '&ntilde;': 'ñ',
  '&uacute;': 'ú',
  '&iacute;': 'í',
  '&oacute;': 'ó',
  '&aacute;': 'á',
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&euro;': '€',
};

export function htmlToText(html: string | undefined | null): string {
  if (!html) return '';
  return html
    .replace(/<div[^>]*>/gi, '\n')
    .replace(/<\/p>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codePoint(Number(n)))
    .replace(/&\w+;/g, (m) => ENTITIES[m] ?? ENTITIES[m.toLowerCase()] ?? ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function codePoint(n: number): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return ' ';
  }
}

// Message classification for filtering. Teams "Message" with messageType RichText/Html or
// Text is a real chat message; everything else (ThreadActivity/*, control, event) is system.
export function isSystemMessage(m: any): boolean {
  const mt = String(m?.messageType ?? '');
  if (m?.type && m.type !== 'Message') return true;
  if (/^ThreadActivity\//i.test(mt)) return true;
  if (/Control|Event|SystemMessage/i.test(mt)) return true;
  return false;
}

// Does this message reference an attachment (image/file/card)? URL-only; we never fetch.
// Accepts fields either directly (mapped row: m.files) or under m.properties.
export function hasAttachment(m: any, contentHtml: string): boolean {
  if (/<img|itemid=|hostedContents|\/v1\/objects\//i.test(contentHtml)) return true;
  for (const src of [m, m?.properties]) {
    if (!src) continue;
    for (const k of ['files', 'cards', 'attachments']) {
      const v = src[k];
      if (typeof v === 'string' && v.length > 2 && v !== '[]') return true;
      if (Array.isArray(v) && v.length) return true;
    }
  }
  return false;
}

// Extract mentioned MRIs from a mentions value — a JSON string, an array, or an object
// carrying .properties.mentions.
export function mentionedMris(mentions: any): string[] {
  let raw = mentions;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.properties)
    raw = raw.properties.mentions;
  let arr: any = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((x) => x?.mri || x?.itemid || x?.id).filter(Boolean);
}
