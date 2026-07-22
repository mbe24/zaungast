import type { StoreView, StoreMeta, ConvMessagesMiss } from 'libzaungast';
import type { RenderCtx } from './types.js';

// Cross-cutting helpers shared by ≥2 tool modules (a helper used by exactly one tool lives in that
// tool's module). Tool descriptions reference HISTORY_NOTE / YOU_NOTE, so those live here too.

// The pinned reading a tool renders: the six query
// namespaces + the build's `meta`, plus `mayBeStale`. It's optional here so a STATIC store
// (`openStore`, used by the MCP-output golden) can be passed directly, while the live MCP dispatch passes a
// full `StoreReading` (`live.current()`); a static store's absent flag reads as not-stale.
export type View = StoreView & { readonly mayBeStale?: boolean };

export const HISTORY_NOTE =
  'Note: this reads the LOCAL Teams cache — history is the synced slice on this device, not the full server archive.';

// The owner's own messages are labelled `<name> (you)`; that speaker is the human account owner,
// NOT you the assistant — attribute those lines to the user, never to yourself.
export const YOU_NOTE =
  'The account owner\'s own messages are labelled "<name> (you)" — that speaker is the user, not you the assistant.';

// ---------- formatting ----------
// The render layer used to read the AMBIENT process timezone + wall clock (getHours/getTimezoneOffset/
// no-arg `new Date()`), which made output depend on where the process runs. It now takes an explicit
// RenderCtx (tz + now). `defaultRenderCtx()` reproduces the old ambient behavior for callers that don't
// supply one (ad-hoc scripts, non-deterministic smokes); the server + goldens pass an explicit ctx.
export function defaultRenderCtx(): RenderCtx {
  return { tz: Intl.DateTimeFormat().resolvedOptions().timeZone, now: Date.now() };
}

// Constructing an Intl.DateTimeFormat is ~90µs; a render formats thousands of timestamps, so cache
// one formatter per zone (the key space is tiny — one zone per process, two under test).
const dtfCache = new Map<string, Intl.DateTimeFormat>();
function dtfFor(tz: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(tz);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    dtfCache.set(tz, dtf);
  }
  return dtf;
}

// Wall-clock parts of an epoch in a given IANA zone. hourCycle 'h23' yields 00–23 (matching the old
// Date.getHours()); 'h23' is set explicitly because hour12:false can render '24' for midnight on some
// ICU builds.
function partsIn(
  tz: string,
  ts: number,
): { y: number; mo: number; d: number; h: number; mi: number } {
  const p: Record<string, string> = {};
  for (const part of dtfFor(tz).formatToParts(ts))
    if (part.type !== 'literal') p[part.type] = part.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

// Offset in HOURS of `tz` at instant `at` (may be fractional, e.g. +5.5) — the same value the old
// `-new Date().getTimezoneOffset() / 60` produced for the process zone, now per-zone + per-instant
// (DST-correct). Interpret the zone-local wall time as if it were UTC; the gap from the real instant
// (floored to the minute) is the offset.
function tzOffsetHours(tz: string, at: number): number {
  const { y, mo, d, h, mi } = partsIn(tz, at);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const atMinute = Math.floor(at / 60000) * 60000;
  return (asUtc - atMinute) / 3600000;
}

export const pad = (n: number) => String(n).padStart(2, '0');
export function fmtTs(ts: number, ctx: RenderCtx = defaultRenderCtx()): string {
  if (!ts) return '--';
  const { y, mo, d, h, mi } = partsIn(ctx.tz, ts);
  const curYear = partsIn(ctx.tz, ctx.now).y;
  const yr = y !== curYear ? `${y}-` : '';
  return `${yr}${pad(mo)}-${pad(d)} ${pad(h)}:${pad(mi)}`;
}
// `HH:mm` in the render zone — the trailing half of a time range (no date/year prefix). Same zone
// basis as fmtTs, so a range's two halves never disagree on the zone.
export function fmtHm(ts: number, ctx: RenderCtx = defaultRenderCtx()): string {
  const { h, mi } = partsIn(ctx.tz, ts);
  return `${pad(h)}:${pad(mi)}`;
}
export function envelope(view: View, ctx: RenderCtx = defaultRenderCtx(), extra = ''): string {
  const meta: StoreMeta = view.meta;
  const tz = tzOffsetHours(ctx.tz, ctx.now);
  const stale = view.mayBeStale ? ' · data:may-be-stale' : '';
  const lossy = meta.lossy ? ' · data:incomplete(source-partially-unreadable)' : '';
  return `as_of ${fmtTs(meta.asOf, ctx)} (tz${tz >= 0 ? '+' : ''}${tz})${stale}${lossy}${extra ? ' · ' + extra : ''}`;
}

// Interpret an offset-less ISO date-time (`2026-07-01T09:00`, or with a space) as WALL TIME in `tz`.
// Date-only forms and offset/Z-bearing forms are left to Date.parse (date-only is UTC per ECMA-262,
// offset-bearing is absolute) — so only the genuinely ambiguous case is zone-resolved here.
function parseIsoInZone(s: string, tz: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(
    s.trim(),
  );
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se, ms] = m;
  // Guess UTC, then correct by the zone's offset at that guess (one pass is exact except inside a
  // DST spring-forward gap, where the wall time doesn't exist — an acceptable edge for a filter bound).
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, se ? +se : 0, ms ? +ms.padEnd(3, '0') : 0);
  const offsetMs = tzOffsetHours(tz, guess) * 3600000;
  return guess - offsetMs;
}
export function parseTime(
  s: string | number | undefined,
  ctx: RenderCtx = defaultRenderCtx(),
): number | undefined {
  if (s == null) return undefined;
  if (typeof s === 'number') return s;
  // Sign-aware relative offset: '-7d' (past, the original/only direction) or '+7d' (future —
  // needed for list_events' forward-looking default window).
  const rel = /^([+-])(\d+)([dhm])$/.exec(s.trim());
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = +rel[2];
    const u = rel[3];
    const subDayMs = u === 'h' ? 36e5 : 6e4;
    return ctx.now + sign * n * (u === 'd' ? 864e5 : subDayMs);
  }
  // Offset-less date-times resolve in ctx.tz (no ambient dependence); everything else via Date.parse.
  const zoned = parseIsoInZone(s, ctx.tz);
  if (zoned !== undefined) return zoned;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
// Reject unparseable time filters loudly instead of silently ignoring them.
export function badTime(
  args: any,
  keys: string[],
  ctx: RenderCtx = defaultRenderCtx(),
): string | null {
  for (const k of keys)
    if (args[k] != null && parseTime(args[k], ctx) === undefined)
      return `error: cannot parse ${k}="${args[k]}" — use ISO (2026-07-01) or relative (-7d / +7d / -24h / -30m)`;
  return null;
}
// Truncate with an ellipsis marker so the agent can tell a message was cut.
export function clip(s: string, n: number): string {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- resolvers / notes ----------
// The resolvers + the fallible query cores live in the libzaungast facade. The presentation below
// turns their structured results (QueryMiss reasons, resolved conversation candidates, coverage
// spans) into the agent-facing note/error text — the library emits no prose.

// Map a library miss reason to its user-facing message (the exact strings the scope-builders used to
// return inline). Handles the read-message `no-such-message` case too (the flat around-pivot miss).
export function describeMiss(m: ConvMessagesMiss): string {
  switch (m.reason) {
    case 'no-such-sender':
      return `no person matches ${m.value}`;
    case 'no-such-conversation':
      return `no conversation matches "${m.value}"`;
    case 'no-such-excluded-conversation':
      return `exclude: no conversation ${m.value}`;
    case 'no-such-excluded-person':
      return `exclude: no person ${m.value}`;
    case 'no-such-message':
      return `message ${m.value} not found in this conversation`;
  }
}

// A conversation title-substring that matches >1 conversation → non-blocking disambiguation note.
// `conversations.resolve` returns the candidate views newest-first (last_ts desc) — the same set
// `in:` resolved to; the MCP owns the >1 threshold, the ≤4 cap, and the prose.
export function convAmbiguityNote(view: View, arg: string): string {
  if (arg.startsWith('c:')) return '';
  const cands = view.conversations.resolve(arg);
  if (cands.length <= 1) return '';
  const names = cands
    .slice(0, 4)
    .map((r) => `${r.handle} ${r.topic || r.participantNames || ''}`.trim())
    .join(', ');
  return `note: in:"${arg}" matched ${cands.length} conversations (${names}) — searching all; pass a c:handle to narrow`;
}

// The account owner's own messages must NOT be labelled with a bare first-person token: to an
// LLM reading the transcript, `ME`/`I` resolves to its OWN voice, so it misattributes the owner's
// messages to itself. Label the owner by real name + a `(you)` marker instead — a named third
// party the agent can't confuse with itself, while `(you)` keeps the human's at-a-glance cue and
// (correctly, for a machine) binds to the agent's human principal, who IS the account owner.
// `ownerFallback` is only used for the degenerate case of an is_mine row with an empty sender_name.
export function ownerLabel(
  senderName: string | null | undefined,
  ownerFallback: string | null,
): string {
  const nm = senderName || ownerFallback;
  return nm ? `${nm} (you)` : '(you)';
}

// The owner's canonical display name (for the fallback + the header legend), or null if it can't
// be resolved (owner never posted / no self MRI).
export function ownerDisplayName(view: View): string | null {
  const selfMri = view.meta.selfMri;
  return selfMri ? view.people.nameFor(selfMri) : null;
}

// One-line header note that tells a machine reader what `(you)` means. Emitted only when the
// result actually contains owner-authored rows; empty when the owner name is unresolved.
export function viewerLegend(name: string | null): string {
  return name ? `viewer: ${name} — "(you)" marks this account's owner, not the assistant` : '';
}
