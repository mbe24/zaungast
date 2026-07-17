import type { StoreView, StoreMeta, ConvMessagesMiss } from 'libzaungast';

// Cross-cutting helpers shared by ≥2 tool modules (a helper used by exactly one tool lives in that
// tool's module). Tool descriptions reference HISTORY_NOTE / YOU_NOTE, so those live here too.

// The pinned reading a tool renders (plan/b3-facade-review.md §3.2/Override 2): the six query
// namespaces + the build's `meta`, plus `mayBeStale`. It's optional here so a STATIC store
// (`openStore`, used by the G2 golden) can be passed directly, while the live MCP dispatch passes a
// full `StoreReading` (`live.current()`); a static store's absent flag reads as not-stale.
export type View = StoreView & { readonly mayBeStale?: boolean };

export const HISTORY_NOTE =
  'Note: this reads the LOCAL Teams cache — history is the synced slice on this device, not the full server archive.';

// The owner's own messages are labelled `<name> (you)`; that speaker is the human account owner,
// NOT you the assistant — attribute those lines to the user, never to yourself.
export const YOU_NOTE =
  'The account owner\'s own messages are labelled "<name> (you)" — that speaker is the user, not you the assistant.';

// ---------- formatting ----------
export const pad = (n: number) => String(n).padStart(2, '0');
export function fmtTs(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  const now = new Date();
  const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}-` : '';
  return `${y}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function envelope(view: View, extra = ''): string {
  const meta: StoreMeta = view.meta;
  const tz = -new Date().getTimezoneOffset() / 60;
  const stale = view.mayBeStale ? ' · data:may-be-stale' : '';
  const lossy = meta.lossy ? ' · data:incomplete(source-partially-unreadable)' : '';
  return `as_of ${fmtTs(meta.asOf)} (tz${tz >= 0 ? '+' : ''}${tz})${stale}${lossy}${extra ? ' · ' + extra : ''}`;
}
export function parseTime(s: string | number | undefined, now = Date.now()): number | undefined {
  if (s == null) return undefined;
  if (typeof s === 'number') return s;
  // Sign-aware relative offset: '-7d' (past, the original/only direction) or '+7d' (future —
  // needed for list_events' forward-looking default window). ISO/epoch handling unchanged.
  const rel = /^([+-])(\d+)([dhm])$/.exec(s.trim());
  if (rel) {
    const sign = rel[1] === '-' ? -1 : 1;
    const n = +rel[2];
    const u = rel[3];
    const subDayMs = u === 'h' ? 36e5 : 6e4;
    return now + sign * n * (u === 'd' ? 864e5 : subDayMs);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
// Reject unparseable time filters loudly instead of silently ignoring them.
export function badTime(args: any, keys: string[]): string | null {
  for (const k of keys)
    if (args[k] != null && parseTime(args[k]) === undefined)
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
