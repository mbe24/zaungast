// get_attachments = the images/files/cards of ONE message. The ingest store keeps only the text of a
// body (images become the [attachment] mark), so this tool goes back to the raw record: it re-loads
// the snapshot backing the current build, decodes that conversation's reply-chain records, takes the
// message's raw HTML + properties.files/cards, lists the references, and — for inline AMS images —
// looks the bytes up in Teams' local HTTP disk cache (Cache/Cache_Data). Cached images come back as
// MCP image content; anything not cached is reported with its URL, since fetching it would need the
// user's Teams/Graph auth, which this offline, read-only server deliberately does not have.
import path from 'node:path';
import {
  discoverTeamsDbs,
  entityTargets,
  extractRecords,
  fingerprint,
  selectMapping,
  type Mapping,
  type SnapshotRecord,
} from 'libzaungast/format';
import type { GetAttachmentsArgs } from '../schemas.js';
import { getAttachmentsShape } from '../schemas.js';
import { HttpCache } from '../media/httpCache.js';
import { attachmentRefs } from '../media/refs.js';
import type { MediaContent, MediaTool, MediaCtx } from './types.js';
import { envelope, fmtTs, ownerDisplayName } from './shared.js';
import { resolveConversationArg, whoLabel } from './readConversation.js';

// Claude's per-image limit is ~5 MB of base64 (≈3.7 MB raw); stay below it.
const MAX_INLINE_BYTES = 3_500_000;

// Where Teams' HTTP cache lives: TEAMS_HTTP_CACHE_DIR, else derived from the leveldb dir
// (<profile>/IndexedDB/<origin>.leveldb → <profile>/Cache/Cache_Data). Static ZAUNGAST_DB_DIR
// copies have no profile next to them, so they need the explicit override.
export function resolveHttpCacheDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates: string[] = [];
  if (env.TEAMS_HTTP_CACHE_DIR) candidates.push(env.TEAMS_HTTP_CACHE_DIR);
  else if (!env.ZAUNGAST_DB_DIR) {
    let leveldb: string | undefined;
    try {
      leveldb = discoverTeamsDbs({ override: env.TEAMS_LEVELDB_DIR })[0]?.dir;
    } catch {
      leveldb = undefined;
    }
    if (leveldb) {
      const profile = path.dirname(path.dirname(path.resolve(leveldb)));
      candidates.push(path.join(profile, 'Cache', 'Cache_Data'), path.join(profile, 'Cache'));
    }
  }
  return candidates.find((d) => HttpCache.exists(d)) ?? null;
}

// A reply-chain record's IndexedDB key embeds the conversation id as a UTF-16BE string, so the
// conversation's records can be picked out WITHOUT decoding the whole store (~1 s on a real cache).
const utf16be = (s: string): Buffer => Buffer.from(s, 'utf16le').swap16();
const keyHas = (r: SnapshotRecord, needle: Buffer): boolean =>
  Buffer.from(r.key.buffer, r.key.byteOffset, r.key.byteLength).includes(needle);

interface RawMessage {
  content: string;
  files: unknown;
  cards: unknown;
}

// The raw message record (content = the untouched RichText/Html body, files/cards = properties.*).
function rawMessage(ctx: MediaCtx, convId: string, id: string): RawMessage | null {
  const snap = ctx.reloadSnapshot();
  const { mapping } = selectMapping(fingerprint(snap));
  if (!mapping) return null;
  // The bundled message mapping + properties.cards (not mapped for ingest, only needed here).
  const base = mapping.entities.message;
  const withCards: Mapping = {
    ...mapping,
    entities: { message: { ...base, fields: { ...base.fields, cards: 'properties.cards' } } },
  };
  const all: SnapshotRecord[] = [];
  for (const sk of entityTargets(snap, mapping, 'message'))
    for (const r of snap.buckets.get(sk)?.records ?? []) all.push(r);

  const pick = (records: SnapshotRecord[]): RawMessage | null => {
    let best: (RawMessage & { version: number }) | null = null;
    for (const r of extractRecords(records, withCards, 'message').records) {
      if (String(r.id) !== id || r.conversationId !== convId) continue;
      const version = Number(r.version) || 0;
      if (!best || version >= best.version)
        best = { content: String(r.content ?? ''), files: r.files, cards: r.cards, version };
    }
    return best;
  };
  const needle = utf16be(convId);
  const mine = all.filter((r) => keyHas(r, needle));
  // Fallback to a full decode if the key layout ever stops embedding the conversation id.
  return pick(mine) ?? (mine.length < all.length ? pick(all) : null);
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

export function getAttachments(
  args: GetAttachmentsArgs = {} as GetAttachmentsArgs,
  ctx: MediaCtx,
): MediaContent[] {
  const text = (t: string): MediaContent[] => [{ type: 'text', text: t }];
  if (!args.conversation)
    return text('error: conversation (handle or title substring) is required');
  if (!args.message) return text('error: message (the m:… id from a search hit) is required');
  const view = ctx.view;
  const resolved = resolveConversationArg(view, String(args.conversation));
  if ('early' in resolved) return text(resolved.early);
  const convId = resolved.id;
  const id = String(args.message).replace(/^m:/, '');
  const row = view.messages.get(convId, id);
  if (!row)
    return text(`${envelope(view, ctx.render)}\nmessage m:${id} not found in this conversation`);
  const conv = view.conversations.get(convId)!;

  const raw = rawMessage(ctx, convId, id);
  if (!raw)
    return text(
      `${envelope(view, ctx.render)}\nm:${id}: raw record not found in the current snapshot`,
    );
  const refs = attachmentRefs(raw.content, raw.files, raw.cards);
  const head = `${conv.handle} · m:${id} · ${fmtTs(row.ts, ctx.render)} ${whoLabel(row, ownerDisplayName(view))}`;
  if (!refs.length)
    return text(
      `${envelope(view, ctx.render)}\n${head}\nno images, files or cards referenced by this message`,
    );
  const index = args.index ? Number(args.index) : null;
  if (index !== null && (index < 1 || index > refs.length))
    return text(
      `${envelope(view, ctx.render)}\n${head}\nindex ${index} out of range — this message has ${refs.length} attachment(s) (1..${refs.length})`,
    );

  const cache = ctx.httpCacheDir ? new HttpCache(ctx.httpCacheDir) : null;
  const lines: string[] = [envelope(view, ctx.render), `${head} · ${refs.length} attachment(s)`];
  const images: MediaContent[] = [];

  refs.forEach((ref, i) => {
    const n = i + 1;
    if (index !== null && n !== index) return;
    if (ref.kind === 'file') {
      lines.push(
        `#${n} file "${ref.name}"${ref.type ? ` (${ref.type})` : ''} · ${ref.url || 'no url'} · not downloadable offline (SharePoint/OneDrive, needs auth)`,
      );
      return;
    }
    if (ref.kind === 'card') {
      lines.push(`#${n} card ${ref.type}${ref.title ? ` "${ref.title}"` : ''}`);
      return;
    }
    const dims = ref.width && ref.height ? ` ${ref.width}x${ref.height}` : '';
    const label = `#${n} image${ref.alt ? ` "${ref.alt}"` : ''}${dims}`;
    if (!ref.objectId) {
      lines.push(`${label} · external ${ref.url} · not looked up (not an AMS object)`);
      return;
    }
    const hit = cache?.findObject(ref.objectId) ?? null;
    if (!hit) {
      const why = cache
        ? 'not in the local Teams HTTP cache (open the chat in Teams to cache it; a direct download needs Teams/Graph auth)'
        : 'Teams HTTP cache not found (set TEAMS_HTTP_CACHE_DIR)';
      lines.push(`${label} · ams ${ref.objectId} · ${why} · ${ref.url}`);
      return;
    }
    const partial =
      hit.contentLength && hit.body.length < hit.contentLength
        ? ` · PARTIAL ${hit.body.length}/${hit.contentLength} bytes`
        : '';
    const inline = hit.body.length <= MAX_INLINE_BYTES && !args.no_inline;
    const shown = inline ? ' · shown below' : args.no_inline ? '' : ' · too large to inline';
    lines.push(
      `${label} · ams ${ref.objectId} · cached ${hit.mimeType} ${kb(hit.body.length)} (view ${hit.view || '-'})${partial}${shown}`,
    );
    if (inline)
      images.push({ type: 'image', data: hit.body.toString('base64'), mimeType: hit.mimeType });
  });
  return [{ type: 'text', text: lines.join('\n') }, ...images];
}

export const getAttachmentsTool: MediaTool = {
  kind: 'media',
  name: 'get_attachments',
  title: 'Read the images/files of one message',
  description:
    "List the attachments of ONE message (the ones marked [attachment]) and SHOW its pasted images: inline images are read from Teams' local HTTP cache and returned as image content. Target by conversation (c:xxxx or title substring) + message:m:<id>. index: only the Nth attachment. no_inline: list without image content. Images Teams never displayed on this device, and shared files (SharePoint/OneDrive), are listed with their URL only — downloading them would need Teams/Graph auth. Cards are listed by type and title.",
  inputSchema: getAttachmentsShape,
  run: getAttachments,
};
