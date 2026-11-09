// Attachment references of ONE raw Teams message: inline images (<img> in the RichText/Html body,
// usually AMS objects), shared files (properties.files) and cards (properties.cards). Pure
// parsing — no I/O.
import { htmlToText } from 'libzaungast';

export interface ImageRef {
  kind: 'image';
  objectId: string | null; // AMS object id (itemid / …/objects/<id>/…); null for a non-AMS image
  url: string; // the src as Teams stored it
  alt: string;
  width: number | null;
  height: number | null;
}

export interface FileRef {
  kind: 'file';
  name: string;
  type: string;
  url: string; // share/object URL (SharePoint / OneDrive) — needs the user's auth to download
}

export interface CardRef {
  kind: 'card';
  type: string; // e.g. application/vnd.microsoft.card.adaptive
  title: string;
}

export type AttachmentRef = ImageRef | FileRef | CardRef;

// Attribute values are entity-encoded HTML text: decode them with libzaungast's htmlToText (the
// same named/numeric entity table get_message uses), so alt texts read identically in both tools.
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = htmlToText(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

const OBJ_IN_URL = /\/objects\/([0-9A-Za-z_-]{8,})(?:\/|$|\?)/;
const num = (s: string | undefined): number | null => {
  const n = Number(s);
  return s && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
};

export function imageRefs(html: string): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const itemtype = a.itemtype ?? '';
    // Emoji / emoticons are images in the HTML too, but they're glyphs, not attachments.
    if (/Emoji|Emoticon/i.test(itemtype) || /\/emoticons?\//i.test(a.src ?? '')) continue;
    const fromUrl = OBJ_IN_URL.exec(a.src ?? '')?.[1] ?? null;
    const isAms = /AMSImage/i.test(itemtype);
    const objectId = (isAms && a.itemid) || fromUrl || null;
    if (!objectId && !/^https?:/i.test(a.src ?? '')) continue;
    const dedupe = objectId ?? a.src;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({
      kind: 'image',
      objectId,
      url: a.src ?? '',
      alt: a.alt ?? '',
      width: num(a.width),
      height: num(a.height),
    });
  }
  return out;
}

// properties.files / properties.cards are JSON strings (sometimes already arrays).
function jsonArray(v: unknown): any[] {
  let arr: any = v;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  return Array.isArray(arr) ? arr.filter((x) => x && typeof x === 'object') : [];
}

export function fileRefs(files: unknown): FileRef[] {
  return jsonArray(files).map((f: any) => ({
    kind: 'file' as const,
    name: String(f.fileName ?? f.title ?? f.name ?? '(unnamed)'),
    type: String(f.fileType ?? f.type ?? ''),
    url: String(f.fileInfo?.shareUrl ?? f.fileInfo?.fileUrl ?? f.objectUrl ?? f.baseUrl ?? ''),
  }));
}

// First human-readable text of a card: its title, else the first TextBlock found in the body.
function cardTitle(content: any): string {
  if (!content || typeof content !== 'object') return '';
  if (typeof content.title === 'string' && content.title) return content.title;
  const stack: any[] = Array.isArray(content.body) ? [...content.body] : [];
  while (stack.length) {
    const el = stack.shift();
    if (!el || typeof el !== 'object') continue;
    if (el.type === 'TextBlock' && typeof el.text === 'string' && el.text.trim()) return el.text;
    for (const k of ['items', 'columns', 'body']) if (Array.isArray(el[k])) stack.push(...el[k]);
  }
  return '';
}

export function cardRefs(cards: unknown): CardRef[] {
  return jsonArray(cards).map((c: any) => {
    let content = c.content;
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch {
        content = null;
      }
    }
    return {
      kind: 'card' as const,
      type: String(c.contentType ?? c.type ?? content?.type ?? 'card'),
      title: cardTitle(content).replace(/\s+/g, ' ').trim().slice(0, 120),
    };
  });
}

export function attachmentRefs(rawHtml: string, files: unknown, cards?: unknown): AttachmentRef[] {
  return [...imageRefs(rawHtml || ''), ...fileRefs(files), ...cardRefs(cards)];
}
