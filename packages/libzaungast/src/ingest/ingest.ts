// Node entry points for ingest — the fs / node:sqlite-bound wrappers around the browser-safe core
// (ingest-core.ts). `ingest(dir)`/`extractForFullIngest(dir)`/`applyIncremental(dir)` load a snapshot
// from the filesystem and use the node:sqlite driver; the pure extract + store-build + apply logic
// lives in ingest-core so the browser facade (openStoreFromSource) can reuse it. Re-exports the core so
// existing importers of `./ingest/ingest.js` (ingest, applyIncremental, Ingested, IngestState, convKind,
// …) are unchanged.
import { loadSnapshot, extractEntity, extractRecords, entityTargets } from '../format/index.js';
import { toHex } from '#bytes';
import type { SnapshotRecord, Snapshot } from '../format/types.js';
import { ChatStore, type StoreMeta } from './store.js';
import { nodeSqlDriver } from './sqlite-node.js';
import {
  extractFromSnapshot,
  buildStore,
  applyMessages,
  applyProfiles,
  applyEvents,
  applyCalls,
  applyConversationMeta,
  setEq,
  type FullExtract,
  type Ingested,
  type IngestState,
  type PhaseHook,
} from './ingest-core.js';

export * from './ingest-core.js';

// Load the snapshot from a leveldb dir, then extract every entity's rows (the extract-then-drop-snapshot
// ordering — the snapshot is unreachable once this frame unwinds, before buildStore runs). `seqCap`
// (tests only) loads as of an earlier sequence so a following applyIncremental can reach a full rebuild.
export function extractForFullIngest(
  dir: string,
  opts: { seqCap?: number; onPhase?: PhaseHook },
): FullExtract {
  return extractFromSnapshot(loadSnapshot(dir, { seqCap: opts.seqCap }), opts);
}

// Engine-author primitive (SPI): adopt a pre-written store .db file as an `Ingested`. An engine that
// builds the ChatStore .db itself (e.g. the native accelerator writes it end-to-end in Rust) calls
// this to wrap the finished file — `ChatStore` stays internal to libzaungast. Engine-neutral: `state`
// is null (an engine needing a private refresh handle overrides it on the returned object). `tempDir`,
// when given, is the throwaway dir holding the .db that `store.close()` removes recursively.
export function openStoreFile(
  dbPath: string,
  meta: StoreMeta,
  opts: { ftsEnabled: boolean; tempDir?: string },
): Ingested {
  const store = new ChatStore(nodeSqlDriver, {
    openFile: dbPath,
    ftsEnabled: opts.ftsEnabled,
    tempFile: opts.tempDir,
  });
  return { store, meta, lossy: meta.lossy, state: null };
}

// FULL rebuild from a fresh snapshot dir (Node): extract from the on-disk snapshot, build on node:sqlite.
export function ingest(dir: string, opts: { seqCap?: number; onPhase?: PhaseHook } = {}): Ingested {
  return buildStore(extractForFullIngest(dir, opts), nodeSqlDriver, opts);
}

// INCREMENTAL apply onto an existing store. Mutates the store in place; the caller updates
// meta/state. `skipped` = a lossy load, nothing applied (retry next refresh); `needFullRebuild`
// = a schema change; either way the caller must not advance state on that basis.
// Accept a dir (reparse-load internally) or a pre-loaded Snapshot (copy-reuse path).
export function applyIncremental(
  store: ChatStore,
  state: IngestState,
  source: string | Snapshot,
): { needFullRebuild: boolean; newMaxSeq: number; skipped: boolean } {
  const snap = typeof source === 'string' ? loadSnapshot(source) : source;
  const { maxSeq: newMax, lossy } = snap;
  // Lossy-load guard: a lossy load (a table/log couldn't be fully read) makes chains spuriously
  // absent from `live`, which the deletion reconcile would treat as deletions. Refuse to apply
  // — serve the current store; a clean read next refresh will catch up.
  if (lossy) return { needFullRebuild: false, newMaxSeq: state.maxSeq, skipped: true };

  // Schema tripwire: if OUR mapped message/conversation stores resolve to different (dbId:osId)
  // pairs than at full ingest, the schema changed under us — a store migrated to a new osId, or
  // a new mapped database appeared → full rebuild. Recomputed from live metadata each refresh.
  // Irrelevant store churn (Teams creates messaging-slice / consumption stores dynamically) is
  // correctly ignored because those don't match our mapping.
  const msgT = entityTargets(snap, state.mapping, 'message');
  const convT = entityTargets(snap, state.mapping, 'conversation');
  if (!setEq(msgT, state.msgTargets) || !setEq(convT, state.convTargets))
    return { needFullRebuild: true, newMaxSeq: state.maxSeq, skipped: false };

  // No-op fast-exit (after the schema tripwire, so a genuine migration still forces a rebuild):
  // `maxSeq` counts tombstones too, so newMax === state.maxSeq means NO writes AND no deletions
  // have landed since the last apply — the store already equals a full rebuild. Skip the whole
  // apply (extract + whole-store replace + recomputeDerived + refreshFts), the bulk of the ~1s
  // no-op refresh cost. The store is untouched; the caller just re-stamps meta.asOf.
  if (newMax === state.maxSeq) return { needFullRebuild: false, newMaxSeq: newMax, skipped: false };

  // Live keys of the message store(s) (for whole-chain / compaction deletion reconcile) and the
  // changed message-store records (seq > maxSeq) to re-extract. Read straight off the message
  // buckets — already grouped by store, no per-entry prefix decode.
  const liveChainKeys = new Set<string>();
  const changedChainKeys = new Set<string>();
  const changedMsgRecords: SnapshotRecord[] = [];
  for (const sk of state.msgTargets) {
    const b = snap.buckets.get(sk);
    if (!b) continue;
    for (const rec of b.records) {
      // hex, matching the chain_key column encoding in applyMessages (NUL-safe read-back).
      const hex = toHex(rec.key);
      liveChainKeys.add(hex);
      if (rec.seq > state.maxSeq) {
        changedChainKeys.add(hex);
        changedMsgRecords.push(rec);
      }
    }
  }

  // Rollback-on-error guard: on any error inside the transaction, ROLLBACK and demand a full rebuild rather
  // than leave a half-mutated store (which the Session's catch would otherwise serve forever).
  try {
    store.db.exec('BEGIN');
    // deletions first (whole-chain gone), then delete changed chains before re-inserting them.
    // Accumulate every deleted + re-inserted message id → `ftsIds`, for a DELTA FTS refresh
    // instead of a full 11.8k-row rebuild. The union provably equals a full rebuild: it covers
    // every id whose messages-table row changed (removed, re-inserted, or both); any message left
    // untouched keeps its existing — and still correct — FTS row.
    const ftsIds = new Set<string>(store.deleteMessagesForMissingChains(liveChainKeys));
    for (const ck of changedChainKeys)
      for (const id of store.deleteMessagesByChain(ck)) ftsIds.add(id);
    const newMsgRows = extractRecords(changedMsgRecords, state.mapping, 'message').records;
    for (const id of applyMessages(store, newMsgRows, state.selfMri)) ftsIds.add(id);
    // profiles/events/calls are all cheap (hundreds of rows) → whole-store replace from the
    // full snapshot each refresh, exactly like profiles — this is what keeps the
    // incremental==full-rebuild invariant trivially true for them.
    applyProfiles(store, snap, state.mapping);
    applyEvents(store, snap, state.mapping);
    applyCalls(store, snap, state.mapping);

    // conversations are cheap → fully reconcile each refresh: re-apply live meta, drop orphans.
    const convRows = extractEntity(snap, state.mapping, 'conversation', state.convTargets).records;
    const liveConvIds = new Set<string>(convRows.map((c: any) => c.id).filter(Boolean));
    store.db.exec(
      'update conversations set topic=null, team_id=null, thread_type=null, meta_last_ts=0',
    );
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
    store.refreshFts(ftsIds); // delta: deleted ∪ re-inserted ids, provably == full rebuild
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
