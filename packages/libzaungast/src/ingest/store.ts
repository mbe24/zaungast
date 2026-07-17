import { DatabaseSync } from 'node:sqlite';
import { readFileSync, rmSync } from 'node:fs';
import { makeHandle } from '../util/handles.js';

// The ChatStore DDL, read from the single-source schema.sql (see that file's header). This is the
// SAME string the native engine (libzaungast-native) execs verbatim, so the two engines' schemas
// cannot drift. Resolved relative to this module: src/schema.sql in dev, dist/schema.sql in prod
// (the build copies it — see package.json). FTS is created separately (conditional on fts5).
export const SCHEMA_SQL = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

export interface StoreMeta {
  asOf: number; // ingest completion time (epoch ms)
  fingerprint: string;
  schemaVersion: string | null;
  schemaMatched: boolean; // false = unknown Teams schema; store is empty, run describe_schema
  counts: { conversations: number; messages: number; people: number };
  earliestTs: number;
  ftsEnabled: boolean;
  lastFullAt: number; // when the last FULL rebuild ran (deletions are exact as of this)
  refreshMode: 'full' | 'incremental';
  lossy: boolean; // true = this build read an incomplete source (some data may be missing)
  selfMri: string | null; // the current user's MRI (for the (you) tag); null if never posted
}

// A sender MRI in the Bot Framework namespace (28:<appId>) is a bot/app, not a person.
// Read-time classification only — no stored column (see Fable review).
export function isBotMri(mri: string | null | undefined): boolean {
  return typeof mri === 'string' && mri.startsWith('28:');
}

export class ChatStore {
  db: DatabaseSync;
  ftsEnabled = false;
  private readonly handleByFull = new Map<string, string>();
  private readonly usedHandles = new Set<string>();

  // Phrase-extraction cache for top_topics: content string → extracted phrases. Persists across
  // tool calls and (for unchanged content) across incremental refreshes. Invalidated when the
  // name-token set changes (names are phrase-breaks, so they alter extraction). Owned here so it
  // shares the store's lifetime and is dropped with a full rebuild's fresh store.
  phraseCache = new Map<string, string[]>();
  phraseCacheSig = '';

  // Set when this store was opened onto a native-built temp .db; unlinked on close().
  private tempFile?: string;

  // Default: an in-memory store, schema created + populated by the TS ingest. `openFile`: open an
  // EXISTING ChatStore .db read-only (the native engine already built it end-to-end) — skips schema
  // creation and ingest; only the query surface (db + ftsEnabled) is used. `tempFile` (if the opened
  // file is a throwaway the native path wrote) is deleted on close().
  constructor(opts?: { openFile?: string; ftsEnabled?: boolean; tempFile?: string }) {
    if (opts?.openFile) {
      this.db = new DatabaseSync(opts.openFile, { readOnly: true });
      this.ftsEnabled = opts.ftsEnabled ?? this.detectFtsFromDb();
      this.tempFile = opts.tempFile;
      return;
    }
    this.db = new DatabaseSync(':memory:');
    this.ftsEnabled = this.detectFts();
    this.db.exec(SCHEMA_SQL);
    if (this.ftsEnabled) {
      this.db.exec(`create virtual table messages_fts using fts5(
        content, conv_id unindexed, id unindexed, tokenize='porter unicode61');`);
    }
  }

  private detectFts(): boolean {
    try {
      const t = new DatabaseSync(':memory:');
      t.exec('create virtual table _p using fts5(x)');
      t.close();
      return true;
    } catch {
      return false;
    }
  }

  // Whether an already-open store has the FTS table (native-opened path fallback; normally the
  // native engine reports ftsEnabled directly, so this is only a safety net).
  private detectFtsFromDb(): boolean {
    try {
      return !!this.db
        .prepare("select 1 from sqlite_master where type='table' and name='messages_fts'")
        .get();
    } catch {
      return false;
    }
  }

  // Stable short handle for a full id, collision-extended. Cache persists across incremental
  // refreshes so a person/conversation keeps the same handle.
  handleFor(prefix: 'c' | 'p', fullId: string): string {
    const cached = this.handleByFull.get(fullId);
    if (cached) return cached;
    // 6 hex chars (24 bits) → collision probability ~16× lower than 5, so the order-dependent
    // extension path below is essentially never hit. Residual (accepted, ~pre-release only): if
    // a fresh full rebuild adds an entity that collides at 6 chars with an existing one, the
    // assignment order can flip which one extends — a stale handle from before that rebuild
    // could then resolve differently. Handles are re-issued in every tool result, so the window
    // is one full rebuild between an agent reading and reusing a handle; negligible in practice.
    for (let len = 6; len <= 40; len++) {
      const h = makeHandle(prefix, fullId, len);
      if (!this.usedHandles.has(h)) {
        this.usedHandles.add(h);
        this.handleByFull.set(fullId, h);
        return h;
      }
    }
    const fb = `${prefix}:${fullId.slice(0, 12)}`;
    this.usedHandles.add(fb);
    this.handleByFull.set(fullId, fb);
    return fb;
  }

  private readonly stmt = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private q(sql: string) {
    let s = this.stmt.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmt.set(sql, s);
    }
    return s;
  }

  upsertConversationMeta(c: {
    id: string;
    kind: string;
    topic: string | null;
    teamId: string | null;
    threadType: string | null;
    metaLastTs: number;
  }) {
    this.q(
      `insert into conversations(id,handle,kind,topic,team_id,thread_type,meta_last_ts) values(?,?,?,?,?,?,?)
      on conflict(id) do update set kind=excluded.kind, topic=excluded.topic, team_id=excluded.team_id, thread_type=excluded.thread_type, meta_last_ts=excluded.meta_last_ts`,
    ).run(c.id, this.handleFor('c', c.id), c.kind, c.topic, c.teamId, c.threadType, c.metaLastTs);
  }

  insertMessage(m: {
    convId: string;
    id: string;
    chainKey: string;
    version: number;
    ts: number;
    senderMri: string;
    senderName: string;
    kind: string;
    isMine: number;
    isSystem: number;
    hasAttach: number;
    mentionsMe: number;
    content: string;
    reactions?: string | null;
    rootId?: string | null;
  }) {
    // H3: the conflict path must update is_system/is_mine/kind too — soft-deletes are edits
    // that clear content and flip these flags. Version guard keeps newest-wins. Reactions ride the
    // same record (a reaction change rewrites the reply-chain record with a fresh seq), so the
    // >= guard lets an equal-version rewrite refresh them.
    this.q(
      `insert into messages
      (conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content,reactions,root_id)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(conv_id,id) do update set
        chain_key=excluded.chain_key, version=excluded.version, ts=excluded.ts,
        sender_mri=excluded.sender_mri, sender_name=excluded.sender_name, kind=excluded.kind,
        is_mine=excluded.is_mine, is_system=excluded.is_system, has_attach=excluded.has_attach,
        mentions_me=excluded.mentions_me, content=excluded.content, reactions=excluded.reactions,
        root_id=excluded.root_id
      where excluded.version >= messages.version`,
    ).run(
      m.convId,
      m.id,
      m.chainKey,
      m.version,
      m.ts,
      m.senderMri,
      m.senderName,
      m.kind,
      m.isMine,
      m.isSystem,
      m.hasAttach,
      m.mentionsMe,
      m.content,
      m.reactions ?? null,
      m.rootId ?? m.id,
    );
  }

  // Reconcile the profiles name-source: replace-all from the current live profiles rows. Cheap
  // (hundreds of rows) and idempotent, so both full and incremental paths just call it.
  replaceProfiles(rows: { mri: string; name: string }[]) {
    this.db.exec('delete from profiles');
    const ins = this.q('insert or replace into profiles(mri,name) values(?,?)');
    for (const r of rows) if (r.mri && r.name) ins.run(r.mri, r.name);
  }

  // Whole-store replace for the calendar → events table, every ingest (full and incremental
  // alike — see replaceProfiles's comment: cheap (hundreds of rows), idempotent, and makes the
  // incremental==full-rebuild invariant trivially hold).
  replaceEvents(
    rows: {
      id: string;
      seriesId: string | null;
      kind: string;
      subject: string | null;
      startTs: number;
      endTs: number;
      isAllDay: number;
      location: string | null;
      organizerName: string | null;
      organizerEmail: string | null;
      cid: string | null;
      myResponse: string | null;
      showAs: string | null;
      isCancelled: number;
      isConfidential: number;
      hasAttach: number;
      attendees: string | null;
      bodyHtml: string | null;
    }[],
  ) {
    this.db.exec('delete from events');
    const ins = this.q(
      `insert or replace into events(
        id,series_id,kind,subject,start_ts,end_ts,is_all_day,location,organizer_name,organizer_email,
        cid,my_response,show_as,is_cancelled,is_confidential,has_attach,attendees,body_html)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(
        r.id,
        r.seriesId,
        r.kind,
        r.subject,
        r.startTs,
        r.endTs,
        r.isAllDay,
        r.location,
        r.organizerName,
        r.organizerEmail,
        r.cid,
        r.myResponse,
        r.showAs,
        r.isCancelled,
        r.isConfidential,
        r.hasAttach,
        r.attendees,
        r.bodyHtml,
      );
  }

  // Whole-store replace for call-history → calls table. Same rationale as replaceEvents/replaceProfiles.
  replaceCalls(
    rows: {
      id: string;
      callType: string | null;
      direction: string | null;
      state: string | null;
      isMissed: number;
      startTs: number;
      durationMs: number;
      counterpartMri: string | null;
      participants: string | null;
      groupThreadId: string | null;
      hasRecording: number;
      recordingLink: string | null;
      hasVoicemail: number;
      spamLevel: string | null;
      isCurrentUserPart: number;
      isDeleted: number;
    }[],
  ) {
    this.db.exec('delete from calls');
    const ins = this.q(
      `insert or replace into calls(
        id,call_type,direction,state,is_missed,start_ts,duration_ms,counterpart_mri,participants,
        group_thread_id,has_recording,recording_link,has_voicemail,spam_level,is_current_user_part,is_deleted)
      values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const r of rows)
      ins.run(
        r.id,
        r.callType,
        r.direction,
        r.state,
        r.isMissed,
        r.startTs,
        r.durationMs,
        r.counterpartMri,
        r.participants,
        r.groupThreadId,
        r.hasRecording,
        r.recordingLink,
        r.hasVoicemail,
        r.spamLevel,
        r.isCurrentUserPart,
        r.isDeleted,
      );
  }

  // Best display name for an MRI: message-sender name first (canonical, most-recent), then the
  // profiles store, else null. Used to resolve reactors — who may never have posted.
  nameForMri(mri: string): string | null {
    const r = this.q(
      `select coalesce(nullif(pe.name,''), nullif(pr.name,'')) name
       from (select ? mri) x
       left join people pe on pe.mri=x.mri
       left join profiles pr on pr.mri=x.mri`,
    ).get(mri) as any;
    return r?.name ?? null;
  }

  // Returns the ids of the messages it deleted, so the caller can feed a delta FTS refresh
  // (chain_key is indexed → the SELECT is a cheap index probe).
  deleteMessagesByChain(chainKey: string): string[] {
    const ids = (
      this.db.prepare('select id from messages where chain_key=?').all(chainKey) as any[]
    ).map((r) => r.id as string);
    this.q('delete from messages where chain_key=?').run(chainKey);
    return ids;
  }

  // Delete messages whose owning reply-chain is no longer present in the live DB (whole-chain
  // deletion / compaction-elided). liveChainKeys = every message-store key currently live.
  // Caller manages the transaction (this runs inside applyIncremental's BEGIN/COMMIT).
  // Returns the deleted message ids (for the delta FTS refresh).
  deleteMessagesForMissingChains(liveChainKeys: Set<string>): string[] {
    this.db.exec('create temp table if not exists _live_chains(k text primary key)');
    this.db.exec('delete from _live_chains');
    const ins = this.q('insert or ignore into _live_chains values(?)');
    for (const k of liveChainKeys) ins.run(k);
    const ids = (
      this.db
        .prepare('select id from messages where chain_key not in (select k from _live_chains)')
        .all() as any[]
    ).map((r) => r.id as string);
    this.db.exec('delete from messages where chain_key not in (select k from _live_chains)');
    return ids;
  }

  // ONE deterministic recompute of all derived state, used by BOTH full and incremental paths,
  // so an incrementally-updated store equals a full rebuild of the same data by construction.
  recomputeDerived(selfMri: string | null) {
    const self = selfMri ?? '';
    // conversations that only exist via messages (no conversation record yet)
    const missing = this.db
      .prepare(
        `select conv_id, min(kind) kind from messages
      where conv_id not in (select id from conversations) group by conv_id order by conv_id`,
      )
      .all() as any[];
    const insC = this.q('insert into conversations(id,handle,kind) values(?,?,?)');
    for (const r of missing) insC.run(r.conv_id, this.handleFor('c', r.conv_id), r.kind);

    // people FIRST — its deterministic name (most-recent message, ts,id tiebreak) is the
    // canonical display name, which participant_names then reuses (R6: avoids SQLite's
    // nondeterministic bare-column-with-max pick on same-sender equal-ts different names).
    this.db.exec('delete from people');
    const ppl = this.db
      .prepare(
        `select sender_mri mri, count(*) c, max(ts) last from messages
      where is_system=0 group by sender_mri order by sender_mri`,
      )
      .all() as any[];
    const nameOf = this.db.prepare(
      `select sender_name from messages where sender_mri=? and is_system=0 order by ts desc, id desc limit 1`,
    );
    const insP = this.q('insert into people(mri,handle,name,msg_count,last_ts) values(?,?,?,?,?)');
    for (const r of ppl) {
      const nm = (nameOf.get(r.mri) as any)?.sender_name ?? '';
      insP.run(r.mri, this.handleFor('p', r.mri), nm, r.c, r.last);
    }

    this.db.exec(`update conversations set
      msg_count=(select count(*) from messages m where m.conv_id=conversations.id and m.is_system=0),
      activity_ts=coalesce((select max(ts) from messages m where m.conv_id=conversations.id and m.is_system=0),0),
      participant_count=(select count(distinct sender_mri) from messages m where m.conv_id=conversations.id and m.is_system=0)`);
    this.db.exec(
      'update conversations set last_ts=max(coalesce(meta_last_ts,0), coalesce(activity_ts,0))',
    );
    // participant_names: deterministic order (mts,sender_mri) and deterministic name (people.name).
    // group_concat over the LIMIT'd ordered subquery preserves order in SQLite (relied upon).
    this.q(
      `update conversations set participant_names=(
      select group_concat(name, ', ') from (
        select pl.name name, max(m.ts) mts, m.sender_mri from messages m
        join people pl on pl.mri=m.sender_mri
        where m.conv_id=conversations.id and m.is_system=0 and m.sender_mri<>? and pl.name<>''
        group by m.sender_mri order by mts desc, m.sender_mri limit 5))`,
    ).run(self);
  }

  // Rebuild FTS for a set of message ids (or all, when ids is null). Re-derived from the
  // messages table (post-upsert), never from the incoming row.
  refreshFts(changedIds: Set<string> | null) {
    if (!this.ftsEnabled) return;
    if (changedIds === null) {
      this.db.exec('delete from messages_fts');
      this.db.exec(
        `insert into messages_fts(content,conv_id,id) select content,conv_id,id from messages where is_system=0 and content<>''`,
      );
      return;
    }
    if (!changedIds.size) return;
    this.db.exec('create temp table if not exists _chg(id text primary key)');
    this.db.exec('delete from _chg');
    const ins = this.q('insert or ignore into _chg values(?)');
    this.db.exec('BEGIN');
    for (const id of changedIds) ins.run(id);
    this.db.exec('COMMIT');
    // single staged delete-join (conv_id/id are unindexed in FTS → avoid per-id scans)
    this.db.exec('delete from messages_fts where id in (select id from _chg)');
    this.db.exec(`insert into messages_fts(content,conv_id,id)
      select content,conv_id,id from messages where id in (select id from _chg) and is_system=0 and content<>''`);
  }

  counts() {
    const c = this.db.prepare('select count(*) n from conversations').get() as any;
    const m = this.db.prepare('select count(*) n from messages').get() as any;
    const p = this.db.prepare('select count(*) n from people').get() as any;
    const e = this.db.prepare('select min(ts) t from messages where ts>0').get() as any;
    return { conversations: c.n, messages: m.n, people: p.n, earliestTs: e.t ?? 0 };
  }

  close() {
    this.db.close();
    if (this.tempFile) {
      try {
        rmSync(this.tempFile, { force: true, recursive: true });
      } catch {
        /* best-effort cleanup of the native engine's throwaway .db dir */
      }
    }
  }
}
