import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadEntries,
  decodePrefix,
  fingerprint,
  loadMapping,
  selectMapping,
  extractEntity,
  entityTargets,
} from '../format/index.js';
import { ChatStore, type StoreMeta } from './store.js';
import { htmlToText, isSystemMessage, mentionedMris, hasAttachment } from '../util/text.js';

const VERSIONS_DIR = fileURLToPath(new URL('../schema/versions/', import.meta.url));

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
const setEq = (a: Set<string>, b: Set<string>) =>
  a.size === b.size && [...a].every((x) => b.has(x));
export interface Ingested {
  store: ChatStore;
  meta: StoreMeta;
  state: IngestState | null;
  lossy: boolean;
}

function loadMappings() {
  return fs
    .readdirSync(VERSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMapping(path.join(VERSIONS_DIR, f)));
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
function applyMessages(store: ChatStore, msgRows: any[], selfMri: string | null): Set<string> {
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
      chainKey: Buffer.from(m.__key, 'latin1').toString('hex'),
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

// Populate the profiles name-source (mri → display name). Whole-store replace each ingest.
function applyProfiles(store: ChatStore, live: any[], mapping: any) {
  const rows = extractEntity(live, mapping, 'profile').map((r: any) => ({
    mri: String(r.mri ?? ''),
    name: String(r.name ?? ''),
  }));
  store.replaceProfiles(rows);
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

// Populate the events table (calendar) — whole-store replace each ingest, exactly like
// applyProfiles (see store.ts's replaceEvents doc). `RecurringMaster` rows are series templates,
// never rendered as an event, so they're dropped here rather than inserted and filtered later.
function applyEvents(store: ChatStore, live: any[], mapping: any) {
  const rows = extractEntity(live, mapping, 'event');
  const out = [];
  for (const r of rows as any[]) {
    if (r.eventType === 'RecurringMaster') continue;
    // objectId verified unique+present across all 407 real rows (0 missing, 0 duplicates) — see
    // the spec's ingest report. Per-row fallback to the leveldb record key (__key, the same
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
  store.replaceEvents(out);
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
// itself (cloud-only, out of scope; see plan/feature.calendar-meeting.md). Prefers the recording
// link, falls back to the transcript's.
function recordingLinkOf(r: any): string | null {
  const lm = r.recordings?.[0]?.linkedMessage ?? r.transcript?.linkedMessage;
  if (!lm?.conversationId || !lm?.linkedMessageId) return null;
  return JSON.stringify({
    conversationId: String(lm.conversationId),
    linkedMessageId: String(lm.linkedMessageId),
  });
}

// Populate the calls table (call-history) — whole-store replace each ingest, like applyEvents.
// `is_missed` maps ONLY callState==='Missed' (the real data's other observed value, 'Declined',
// is a deliberate reject — not a miss — see the ingest report for the full enumeration).
function applyCalls(store: ChatStore, live: any[], mapping: any) {
  const rows = extractEntity(live, mapping, 'call');
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
  store.replaceCalls(out);
}

function applyConversationMeta(store: ChatStore, convRows: any[]) {
  for (const c of convRows) {
    if (!c.id) continue;
    store.upsertConversationMeta({
      id: c.id,
      kind: convKind(c.id),
      topic: c.topic || null,
      teamId: c.teamId || null,
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
    schemaVersion: mapping?.schemaVersion ?? null,
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

// FULL rebuild from a fresh snapshot dir. `seqCap` (tests only) builds a PARTIAL store as of
// an earlier sequence, so a following applyIncremental can be proven to reach a full rebuild.
export function ingest(dir: string, opts: { seqCap?: number } = {}): Ingested {
  const { live, maxSeq, lossy } = loadEntries(dir, { seqCap: opts.seqCap });
  const fp = fingerprint(live);
  const { mapping } = selectMapping(loadMappings(), fp);
  if (!mapping) {
    const store = new ChatStore();
    return {
      store,
      state: null,
      lossy,
      meta: {
        asOf: Date.now(),
        fingerprint: fp.hash,
        schemaVersion: null,
        schemaMatched: false,
        counts: { conversations: 0, messages: 0, people: 0 },
        earliestTs: 0,
        ftsEnabled: store.ftsEnabled,
        lastFullAt: Date.now(),
        refreshMode: 'full',
        lossy,
        selfMri: null,
      },
    };
  }
  const msgTargets: Set<string> = entityTargets(live, mapping, 'message');
  const convTargets: Set<string> = entityTargets(live, mapping, 'conversation');
  const msgRows = extractEntity(live, mapping, 'message', msgTargets);
  const convRows = extractEntity(live, mapping, 'conversation', convTargets);
  const selfMri = voteSelfMri(msgRows);

  const store = new ChatStore();
  store.db.exec('BEGIN');
  applyConversationMeta(store, convRows);
  applyMessages(store, msgRows, selfMri);
  applyProfiles(store, live, mapping);
  applyEvents(store, live, mapping);
  applyCalls(store, live, mapping);
  store.db.exec('COMMIT');
  store.recomputeDerived(selfMri);
  store.refreshFts(null);

  const meta = finalMeta(store, fp, mapping, 'full', Date.now(), lossy, selfMri);
  return { store, meta, lossy, state: { mapping, selfMri, msgTargets, convTargets, maxSeq } };
}

// INCREMENTAL apply onto an existing store. Mutates the store in place; the caller updates
// meta/state. `skipped` = a lossy load, nothing applied (retry next refresh); `needFullRebuild`
// = a schema change; either way the caller must not advance state on that basis.
export interface LoadedEntries {
  live: any[];
  maxSeq: number;
  lossy: boolean;
}

// Overload: accept a dir (reparse-load internally) or pre-loaded entries (copy-reuse path).
export function applyIncremental(
  store: ChatStore,
  state: IngestState,
  source: string | LoadedEntries,
): { needFullRebuild: boolean; newMaxSeq: number; skipped: boolean } {
  const { live, maxSeq: newMax, lossy } = typeof source === 'string' ? loadEntries(source) : source;
  // HOLE 1 fix: a lossy load (a table/log couldn't be fully read) makes chains spuriously
  // absent from `live`, which the deletion reconcile would treat as deletions. Refuse to apply
  // — serve the current store; a clean read next refresh will catch up.
  if (lossy) return { needFullRebuild: false, newMaxSeq: state.maxSeq, skipped: true };

  // H3/H5 tripwire: if OUR mapped message/conversation stores resolve to different (dbId:osId)
  // pairs than at full ingest, the schema changed under us — a store migrated to a new osId, or
  // a new mapped database appeared → full rebuild. Recomputed from live metadata each refresh.
  // Irrelevant store churn (Teams creates messaging-slice / consumption stores dynamically) is
  // correctly ignored because those don't match our mapping.
  const msgT = entityTargets(live, state.mapping, 'message');
  const convT = entityTargets(live, state.mapping, 'conversation');
  if (!setEq(msgT, state.msgTargets) || !setEq(convT, state.convTargets))
    return { needFullRebuild: true, newMaxSeq: state.maxSeq, skipped: false };

  // Live keys of the message store (for whole-chain / compaction deletion reconcile) and the
  // changed message-store records (seq > maxSeq) to re-extract.
  const liveChainKeys = new Set<string>();
  const changedChainKeys = new Set<string>();
  const newLive: any[] = [];
  for (const e of live) {
    let p: any;
    try {
      p = decodePrefix(e.key);
    } catch {
      continue;
    }
    if (p.indexId !== 1) {
      if (e.seq > state.maxSeq) newLive.push(e);
      continue;
    }
    const sk = `${p.databaseId}:${p.objectStoreId}`;
    if (state.msgTargets.has(sk)) {
      // hex, matching the chain_key column encoding in applyMessages (NUL-safe read-back).
      liveChainKeys.add(e.key.toString('hex'));
      if (e.seq > state.maxSeq) changedChainKeys.add(e.key.toString('hex'));
    }
    if (e.seq > state.maxSeq) newLive.push(e);
  }

  // HOLE 2 fix: on any error inside the transaction, ROLLBACK and demand a full rebuild rather
  // than leave a half-mutated store (which the Session's catch would otherwise serve forever).
  try {
    store.db.exec('BEGIN');
    // deletions first (whole-chain gone), then delete changed chains before re-inserting them
    store.deleteMessagesForMissingChains(liveChainKeys);
    for (const ck of changedChainKeys) store.deleteMessagesByChain(ck);
    const newMsgRows = extractEntity(newLive, state.mapping, 'message', state.msgTargets);
    applyMessages(store, newMsgRows, state.selfMri);
    // profiles/events/calls are all cheap (hundreds of rows) → whole-store replace from the
    // full live set each refresh, exactly like profiles — this is what keeps the
    // incremental==full-rebuild invariant trivially true for them.
    applyProfiles(store, live, state.mapping);
    applyEvents(store, live, state.mapping);
    applyCalls(store, live, state.mapping);

    // conversations are cheap → fully reconcile each refresh: re-apply live meta, drop orphans.
    const convRows = extractEntity(live, state.mapping, 'conversation', state.convTargets);
    const liveConvIds = new Set<string>(convRows.map((c: any) => c.id).filter(Boolean));
    store.db.exec('update conversations set topic=null, team_id=null, meta_last_ts=0');
    applyConversationMeta(store, convRows);
    store.db.exec('create temp table if not exists _liveconv(id text primary key)');
    store.db.exec('delete from _liveconv');
    const insLc = store.db.prepare('insert or ignore into _liveconv values(?)');
    for (const id of liveConvIds) insLc.run(id);
    store.db.exec(
      'delete from conversations where id not in (select id from _liveconv) and id not in (select distinct conv_id from messages)',
    );
    store.db.exec('COMMIT');
    // Derived recompute + FTS are inside the try too: a throw here (post-COMMIT → committed
    // messages but stale aggregates) also returns needFullRebuild, so the Session rebuilds a
    // clean store rather than serving inconsistent aggregates.
    store.recomputeDerived(state.selfMri);
    store.refreshFts(null);
  } catch (e) {
    try {
      store.db.exec('ROLLBACK');
    } catch {
      /* already rolled back / already committed */
    }
    console.error(`incremental apply failed, forcing full rebuild: ${(e as Error).message}`);
    return { needFullRebuild: true, newMaxSeq: state.maxSeq, skipped: false };
  }

  return { needFullRebuild: false, newMaxSeq: newMax, skipped: false };
}
