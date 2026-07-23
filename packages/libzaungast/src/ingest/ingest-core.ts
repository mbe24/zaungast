// Browser-safe ingest core: extract a snapshot's rows and build/populate a ChatStore on an injected
// SqlDriver. No node:fs, no node:sqlite, no Session — the fs/dir/node:sqlite entry points live in
// ingest.ts (which re-exports this module). Format helpers are imported from their DIRECT pure modules
// (fingerprint.js, resolver.js), NOT format/index.js, which re-exports the fs-backed loaders and would
// pull node:fs into the browser bundle.
import { fingerprint } from '../format/fingerprint.js';
import { selectMapping, extractEntity, entityTargets } from '../format/resolver.js';
import { fromLatin1, toHex } from '#bytes';
import type { Snapshot } from '../format/types.js';
import { ChatStore, type StoreMeta } from './store.js';
import type { SqlDriver } from './sql-driver.js';
import { htmlToText, isSystemMessage, mentionedMris, hasAttachment } from '../util/text.js';

export function convKind(id = ''): string {
  if (id.includes('@unq.gbl.spaces')) return '1:1';
  if (id.includes('meeting_')) return 'meeting';
  if (id.includes('@thread.v2')) return 'group';
  if (id.includes('@thread.skype') || id.includes('@thread.tacv2')) return 'channel';
  return 'other';
}

// State cached from a full ingest, reused to apply incremental updates without re-resolving
// the schema or re-decoding unchanged records.
export interface IngestState {
  mapping: any;
  selfMri: string | null;
  msgTargets: Set<string>;
  convTargets: Set<string>;
  maxSeq: number;
}
export const setEq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
export interface Ingested {
  store: ChatStore;
  meta: StoreMeta;
  // Engine-PRIVATE opaque state, round-tripped by the Session (which only ever checks EXISTENCE, never
  // inspects the shape). JS engine → an `IngestState`; native engine → a `{ native: NativeHandle }`
  // handle; unknown-schema (no mapping) → null. The owning engine discriminates it.
  state: unknown;
  lossy: boolean;
}

// Compact `properties.emotions` to the minimum the renderer needs and a stable JSON string:
// per emoji key, the reactor MRIs with their reaction times. Order-normalized (key asc, then
// mri asc) so an unchanged reaction set serializes identically across refreshes. Returns null
// when there are no reactions, so the column stays empty for the ~84% of messages without any.
export function compactReactions(emotions: any): string | null {
  if (!Array.isArray(emotions) || emotions.length === 0) return null;
  const groups: { k: string; u: [string, number][] }[] = [];
  for (const e of emotions) {
    if (!e || typeof e.key !== 'string' || !Array.isArray(e.users) || e.users.length === 0)
      continue;
    const u: [string, number][] = [];
    for (const usr of e.users) {
      if (usr && usr.mri) u.push([String(usr.mri), Number(usr.time) || 0]);
    }
    if (u.length === 0) continue;
    u.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    groups.push({ k: e.key, u });
  }
  if (groups.length === 0) return null;
  groups.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return JSON.stringify(groups);
}

// Insert message rows (each carries __key = its reply-chain record key → chain_key).
export function applyMessages(
  store: ChatStore,
  msgRows: any[],
  selfMri: string | null,
): Set<string> {
  const changedIds = new Set<string>();
  for (const m of msgRows) {
    const convId = m.conversationId;
    if (!convId) continue;
    const ts = Number(m.time) || Date.parse(m.time) || Number(m.id) || 0;
    const rawHtml = m.content || '';
    const senderMri = m.senderId || '?';
    const isMine = (selfMri && senderMri === selfMri) || m.isSentByCurrentUser ? 1 : 0;
    const mentionsMe = selfMri && !isMine && mentionedMris(m.mentions).includes(selfMri) ? 1 : 0;
    // Reply-chain root: Teams sets a root's parentMessageId to its own id, and each reply's
    // parentMessageId to the root's id. So root_id = parent (when it's a real, different id) else
    // self. Channels render threaded on this; 1:1/group messages are each their own root.
    const idStr = String(m.id);
    const parent = m.parentMessageId != null ? String(m.parentMessageId) : '';
    const rootId = parent && parent !== idStr ? parent : idStr;
    store.insertMessage({
      convId,
      id: idStr,
      // hex-encode the chain key: it's a binary leveldb key (embedded NUL bytes), and node:sqlite
      // truncates a TEXT value at the first NUL on read-back — so a raw latin1 chain_key reads back
      // as '' for essentially every real key. hex is NUL-free, round-trips, and the reconcile stays
      // correct as long as liveChainKeys/changedChainKeys use the same encoding (they do, below).
      chainKey: toHex(fromLatin1(m.__key)),
      version: Number(m.version) || 0,
      ts,
      senderMri,
      senderName: m.senderName || '',
      kind: convKind(convId),
      isMine,
      isSystem: isSystemMessage(m) ? 1 : 0,
      hasAttach: hasAttachment(m, rawHtml) ? 1 : 0,
      mentionsMe,
      content: htmlToText(rawHtml),
      reactions: compactReactions(m.reactions),
      rootId,
    });
    changedIds.add(idStr);
  }
  return changedIds;
}

// Extract the profiles name-source rows (mri → display name) from the snapshot. Split from
// applyProfiles so a full ingest can extract every entity's rows BEFORE building the store, then
// drop the snapshot (the extract-then-drop-snapshot ordering — see extractFromSnapshot()).
function buildProfileRows(snap: Snapshot, mapping: any) {
  return extractEntity(snap, mapping, 'profile').records.map((r: any) => ({
    mri: String(r.mri ?? ''),
    name: String(r.name ?? ''),
  }));
}
// Populate the profiles name-source. Whole-store replace each ingest.
export function applyProfiles(store: ChatStore, snap: Snapshot, mapping: any) {
  store.replaceProfiles(buildProfileRows(snap, mapping));
}

// startTime/endTime decode as a real JS Date (structured-clone tag 0x44) in production Teams
// data, but the fixture encoder (test/fixture/encode.ts) has no Date case and emits a plain ISO
// string instead — accept both, plus a raw epoch number for good measure.
function toEpochMs(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof v === 'number') return v;
  return 0;
}

// Compact an event's attendees[] ({name,address,role,status.response}) to JSON [{n,e,r}]
// (name, email, response), order-normalized (name then email) so an unchanged attendee list
// serializes identically across refreshes. Returns null when there are no named attendees.
function compactAttendees(attendees: unknown): string | null {
  if (!Array.isArray(attendees) || attendees.length === 0) return null;
  const out = attendees
    // Drop room/equipment resources — Teams lists them as attendees (with `type: "Resource"`;
    // `role` is uniformly "User" and doesn't distinguish them), but they're not people and would
    // otherwise inflate the attendee count/tally. The room itself is carried in `location`.
    .filter((a: any) => String(a?.type ?? '').toLowerCase() !== 'resource')
    .map((a: any) => ({
      n: String(a?.name ?? ''),
      e: String(a?.address ?? ''),
      r: String(a?.status?.response ?? ''),
    }))
    .filter((x) => x.n || x.e);
  if (!out.length) return null;
  out.sort((a, b) => (a.n === b.n ? (a.e < b.e ? -1 : a.e > b.e ? 1 : 0) : a.n < b.n ? -1 : 1));
  return JSON.stringify(out);
}

// Build the events table rows (calendar) from the snapshot. Split from applyEvents for the
// extract-then-drop-snapshot ordering. `RecurringMaster` rows are series templates,
// never rendered as an event, so they're dropped here rather than inserted and filtered later.
function buildEventRows(snap: Snapshot, mapping: any) {
  const rows = extractEntity(snap, mapping, 'event').records;
  const out = [];
  for (const r of rows as any[]) {
    if (r.eventType === 'RecurringMaster') continue;
    // objectId verified unique+present across all 407 real rows (0 missing, 0 duplicates).
    // Per-row fallback to the leveldb record key (__key, the same
    // mechanism extractEntity attaches for messages) stays as defensive belt-and-braces in case a
    // future/odd row ever lacks one.
    const id = r.id ? String(r.id) : String(r.__key);
    const cidRaw = typeof r.cid === 'string' ? r.cid : null;
    const cid = cidRaw && cidRaw.includes('19:meeting_') ? cidRaw : null;
    const isMeeting = !!cid || r.isOnlineMeeting === true;
    const isConfidential = !!r.sensitivityLabelId || r.doNotForward === true;
    out.push({
      id,
      seriesId: r.seriesId != null ? String(r.seriesId) : null,
      kind: isMeeting ? 'meeting' : 'appointment',
      subject: r.subject != null ? String(r.subject) : null,
      startTs: toEpochMs(r.startTime),
      endTs: toEpochMs(r.endTime),
      isAllDay: r.isAllDay === true ? 1 : 0,
      location: r.location != null ? String(r.location) : null,
      organizerName: r.organizerName != null ? String(r.organizerName) : null,
      organizerEmail: r.organizerEmail != null ? String(r.organizerEmail) : null,
      cid,
      myResponse: r.myResponse != null ? String(r.myResponse) : null,
      showAs: r.showAs != null ? String(r.showAs) : null,
      isCancelled: r.isCancelled === true ? 1 : 0,
      isConfidential: isConfidential ? 1 : 0,
      hasAttach: r.hasAttachments === true ? 1 : 0,
      attendees: compactAttendees(r.attendees),
      bodyHtml: r.bodyContent != null ? String(r.bodyContent) : null,
    });
  }
  return out;
}
// Populate the events table — whole-store replace each ingest, exactly like applyProfiles
// (see store.ts's replaceEvents doc).
export function applyEvents(store: ChatStore, snap: Snapshot, mapping: any) {
  store.replaceEvents(buildEventRows(snap, mapping));
}

// Compact a MultiParty call's participantList[] ({id,displayName,…}) to JSON [{mri,name}],
// order-normalized by mri. Returns null when empty (TwoParty calls don't carry this).
function compactParticipants(list: unknown): string | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = list
    .map((p: any) => ({
      mri: String(p?.id ?? ''),
      name: p?.displayName != null ? String(p.displayName) : null,
    }))
    .filter((x) => x.mri);
  if (!out.length) return null;
  out.sort((a, b) => (a.mri < b.mri ? -1 : a.mri > b.mri ? 1 : 0));
  return JSON.stringify(out);
}

// A recording/transcript's pointer to the chat message that announced it — never the media
// itself (cloud-only, out of scope). Prefers the recording
// link, falls back to the transcript's.
function recordingLinkOf(r: any): string | null {
  const lm = r.recordings?.[0]?.linkedMessage ?? r.transcript?.linkedMessage;
  if (!lm?.conversationId || !lm?.linkedMessageId) return null;
  return JSON.stringify({
    conversationId: String(lm.conversationId),
    linkedMessageId: String(lm.linkedMessageId),
  });
}

// Build the calls table rows (call-history) from the snapshot. Split from applyCalls for the
// extract-then-drop-snapshot ordering.
// `is_missed` maps ONLY callState==='Missed' (the real data's other observed value, 'Declined',
// is a deliberate reject — not a miss).
function buildCallRows(snap: Snapshot, mapping: any) {
  const rows = extractEntity(snap, mapping, 'call').records;
  const out = [];
  for (const r of rows as any[]) {
    const direction = r.callDirection != null ? String(r.callDirection) : null;
    const counterpart = direction === 'Outgoing' ? r.target : r.originator;
    const counterpartMri = counterpart?.id != null ? String(counterpart.id) : null;
    const state = r.callState != null ? String(r.callState) : null;
    const callType = r.callType != null ? String(r.callType) : null;
    out.push({
      id: r.id ? String(r.id) : String(r.__key),
      callType,
      direction,
      state,
      isMissed: state === 'Missed' ? 1 : 0,
      startTs: toEpochMs(r.startTime),
      durationMs: Number(r.durationInMs) || 0,
      counterpartMri,
      participants: callType === 'MultiParty' ? compactParticipants(r.participantList) : null,
      groupThreadId: r.groupChatThreadId != null ? String(r.groupChatThreadId) : null,
      hasRecording: Array.isArray(r.recordings) && r.recordings.length > 0 ? 1 : 0,
      recordingLink: recordingLinkOf(r),
      hasVoicemail: r.voicemailMetadata ? 1 : 0,
      spamLevel: r.spamRiskLevel != null ? String(r.spamRiskLevel) : null,
      isCurrentUserPart: r.isCurrentUserPartOfCall === false ? 0 : 1,
      isDeleted: r.isDeleted === true ? 1 : 0,
    });
  }
  return out;
}
// Populate the calls table — whole-store replace each ingest, like applyEvents.
export function applyCalls(store: ChatStore, snap: Snapshot, mapping: any) {
  store.replaceCalls(buildCallRows(snap, mapping));
}

export function applyConversationMeta(store: ChatStore, convRows: any[]) {
  for (const c of convRows) {
    if (!c.id) continue;
    store.upsertConversationMeta({
      id: c.id,
      kind: convKind(c.id),
      topic: c.topic || null,
      teamId: c.teamId || null,
      // Teams' own conversation-type string (threadProperties.threadType), persisted verbatim.
      // `kind` stays purely id-derived — this is the faithful raw value alongside it.
      threadType: c.threadType || null,
      metaLastTs: Number(c.lastMessageTimeUtc) || 0,
    });
  }
}

function voteSelfMri(msgRows: any[]): string | null {
  const votes = new Map<string, number>();
  for (const m of msgRows)
    if (m.isSentByCurrentUser && m.senderId)
      votes.set(m.senderId, (votes.get(m.senderId) || 0) + 1);
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function finalMeta(
  store: ChatStore,
  fp: any,
  mapping: any,
  mode: 'full' | 'incremental',
  lastFullAt: number,
  lossy: boolean,
  selfMri: string | null,
): StoreMeta {
  const c = store.counts();
  return {
    asOf: Date.now(),
    fingerprint: fp.hash,
    mappingVersion: mapping?.mappingVersion ?? null,
    schemaMatched: true,
    counts: { conversations: c.conversations, messages: c.messages, people: c.people },
    earliestTs: c.earliestTs,
    ftsEnabled: store.ftsEnabled,
    lastFullAt,
    refreshMode: mode,
    lossy,
    selfMri,
  };
}

// Everything a full ingest extracts from a snapshot, as plain row arrays (no Buffer slices, no
// snapshot references). `mapping` is null when no schema matched.
export interface FullExtract {
  fp: any;
  mapping: any;
  maxSeq: number;
  lossy: boolean;
  selfMri: string | null;
  msgTargets: Set<string>;
  convTargets: Set<string>;
  msgRows: any[];
  convRows: any[];
  profileRows: ReturnType<typeof buildProfileRows>;
  eventRows: ReturnType<typeof buildEventRows>;
  callRows: ReturnType<typeof buildCallRows>;
}

// Opt-in profiling hook (dev only — see scripts/profile.mjs). Fires once per store-build phase with
// its wall-clock in ms. PURE OBSERVATION: it never changes control flow or output and is a no-op in
// production (a `performance.now()` pair runs only when a hook is supplied). Mirrors the native
// `build_store_timed` measure-and-discard so both engines report the same phase breakdown.
export type PhaseHook = (phase: 'extract' | 'apply' | 'recompute' | 'fts', ms: number) => void;

// Extract EVERY entity's rows from an already-loaded snapshot. Callers load the snapshot then let its
// frame unwind before buildStore() runs, so the ~56MB decode graph and the growing store never coexist
// (lower peak RSS). Extracted rows carry only decoded values + a latin1 __key string, never Buffer
// slices, so nothing returned here pins the snapshot. Byte-identical: extraction order doesn't affect
// any inserted value, selfMri, or the fingerprint (computed here, unchanged). The `extract` phase is
// timed here (after selectMapping, excluding voteSelfMri), mirroring the native build.
export function extractFromSnapshot(
  snap: Snapshot,
  opts: { onPhase?: PhaseHook } = {},
): FullExtract {
  const { maxSeq, lossy } = snap;
  const fp = fingerprint(snap);
  const { mapping } = selectMapping(fp);
  if (!mapping)
    return {
      fp,
      mapping: null,
      maxSeq,
      lossy,
      selfMri: null,
      msgTargets: new Set(),
      convTargets: new Set(),
      msgRows: [],
      convRows: [],
      profileRows: [],
      eventRows: [],
      callRows: [],
    };
  const tExtract = opts.onPhase ? performance.now() : 0;
  const msgTargets: Set<string> = entityTargets(snap, mapping, 'message');
  const convTargets: Set<string> = entityTargets(snap, mapping, 'conversation');
  const msgRows = extractEntity(snap, mapping, 'message', msgTargets).records;
  const convRows = extractEntity(snap, mapping, 'conversation', convTargets).records;
  const profileRows = buildProfileRows(snap, mapping);
  const eventRows = buildEventRows(snap, mapping);
  const callRows = buildCallRows(snap, mapping);
  // Matches native storeBuild.extract (the five extract_rows) — selfMri vote is timed OUT, as native does.
  opts.onPhase?.('extract', performance.now() - tExtract);
  const selfMri = voteSelfMri(msgRows);
  return {
    fp,
    mapping,
    maxSeq,
    lossy,
    selfMri,
    msgTargets,
    convTargets,
    msgRows,
    convRows,
    profileRows,
    eventRows,
    callRows,
  };
}

// Build + populate a ChatStore on the injected driver from a FullExtract. No-mapping (unknown schema) →
// an empty store with schemaMatched:false. Otherwise: apply all rows in one transaction, recompute
// derived aggregates, build FTS, and return the store + meta + the reusable IngestState.
export function buildStore(
  ex: FullExtract,
  driver: SqlDriver,
  opts: { onPhase?: PhaseHook } = {},
): Ingested {
  if (!ex.mapping) {
    const store = new ChatStore(driver);
    return {
      store,
      state: null,
      lossy: ex.lossy,
      meta: {
        asOf: Date.now(),
        fingerprint: ex.fp.hash,
        mappingVersion: null,
        schemaMatched: false,
        counts: { conversations: 0, messages: 0, people: 0 },
        earliestTs: 0,
        ftsEnabled: store.ftsEnabled,
        lastFullAt: Date.now(),
        refreshMode: 'full',
        lossy: ex.lossy,
        selfMri: null,
      },
    };
  }

  const store = new ChatStore(driver);
  const tApply = opts.onPhase ? performance.now() : 0;
  store.db.exec('BEGIN');
  applyConversationMeta(store, ex.convRows);
  applyMessages(store, ex.msgRows, ex.selfMri);
  store.replaceProfiles(ex.profileRows);
  store.replaceEvents(ex.eventRows);
  store.replaceCalls(ex.callRows);
  store.db.exec('COMMIT');
  opts.onPhase?.('apply', performance.now() - tApply);
  const tRecompute = opts.onPhase ? performance.now() : 0;
  store.recomputeDerived(ex.selfMri);
  opts.onPhase?.('recompute', performance.now() - tRecompute);
  const tFts = opts.onPhase ? performance.now() : 0;
  store.refreshFts(null);
  opts.onPhase?.('fts', performance.now() - tFts);

  const meta = finalMeta(store, ex.fp, ex.mapping, 'full', Date.now(), ex.lossy, ex.selfMri);
  return {
    store,
    meta,
    lossy: ex.lossy,
    state: {
      mapping: ex.mapping,
      selfMri: ex.selfMri,
      msgTargets: ex.msgTargets,
      convTargets: ex.convTargets,
      maxSeq: ex.maxSeq,
    },
  };
}
