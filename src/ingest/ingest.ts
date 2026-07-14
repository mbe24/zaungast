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
  maxSeq: bigint;
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
    store.insertMessage({
      convId,
      id: String(m.id),
      chainKey: m.__key,
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
    });
    changedIds.add(String(m.id));
  }
  return changedIds;
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
export function ingest(dir: string, opts: { seqCap?: bigint } = {}): Ingested {
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
  maxSeq: bigint;
  lossy: boolean;
}

// Overload: accept a dir (reparse-load internally) or pre-loaded entries (copy-reuse path).
export function applyIncremental(
  store: ChatStore,
  state: IngestState,
  source: string | LoadedEntries,
): { needFullRebuild: boolean; newMaxSeq: bigint; skipped: boolean } {
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
      liveChainKeys.add(e.key.toString('latin1'));
      if (e.seq > state.maxSeq) changedChainKeys.add(e.key.toString('latin1'));
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
