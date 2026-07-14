import { DatabaseSync } from 'node:sqlite';
import { makeHandle } from '../util/handles.js';

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
  private handleByFull = new Map<string, string>();
  private usedHandles = new Set<string>();

  // Phrase-extraction cache for top_topics: content string → extracted phrases. Persists across
  // tool calls and (for unchanged content) across incremental refreshes. Invalidated when the
  // name-token set changes (names are phrase-breaks, so they alter extraction). Owned here so it
  // shares the store's lifetime and is dropped with a full rebuild's fresh store.
  phraseCache = new Map<string, string[]>();
  phraseCacheSig = '';

  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.ftsEnabled = this.detectFts();
    this.db.exec(`
      create table conversations(
        id text primary key, handle text unique, kind text,
        -- meta, written from conversation records:
        topic text, team_id text, meta_last_ts integer default 0,
        -- derived, recomputed from messages:
        msg_count integer default 0, participant_names text, participant_count integer default 0,
        activity_ts integer default 0, last_ts integer default 0
      );
      create table people(
        mri text primary key, handle text unique, name text,
        msg_count integer default 0, last_ts integer default 0
      );
      create table messages(
        conv_id text, id text, chain_key text, version integer default 0, ts integer,
        sender_mri text, sender_name text, kind text, is_mine integer default 0,
        is_system integer default 0, has_attach integer default 0, mentions_me integer default 0,
        content text,
        primary key(conv_id, id)
      );
      create index msg_conv_ts on messages(conv_id, ts);
      create index msg_sender_ts on messages(sender_mri, ts);
      create index msg_ts on messages(ts);
      create index msg_chain on messages(chain_key);
    `);
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

  private stmt = new Map<string, ReturnType<DatabaseSync['prepare']>>();
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
    metaLastTs: number;
  }) {
    this.q(
      `insert into conversations(id,handle,kind,topic,team_id,meta_last_ts) values(?,?,?,?,?,?)
      on conflict(id) do update set kind=excluded.kind, topic=excluded.topic, team_id=excluded.team_id, meta_last_ts=excluded.meta_last_ts`,
    ).run(c.id, this.handleFor('c', c.id), c.kind, c.topic, c.teamId, c.metaLastTs);
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
  }) {
    // H3: the conflict path must update is_system/is_mine/kind too — soft-deletes are edits
    // that clear content and flip these flags. Version guard keeps newest-wins.
    this.q(
      `insert into messages
      (conv_id,id,chain_key,version,ts,sender_mri,sender_name,kind,is_mine,is_system,has_attach,mentions_me,content)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?)
      on conflict(conv_id,id) do update set
        chain_key=excluded.chain_key, version=excluded.version, ts=excluded.ts,
        sender_mri=excluded.sender_mri, sender_name=excluded.sender_name, kind=excluded.kind,
        is_mine=excluded.is_mine, is_system=excluded.is_system, has_attach=excluded.has_attach,
        mentions_me=excluded.mentions_me, content=excluded.content
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
    );
  }

  deleteMessagesByChain(chainKey: string) {
    this.q('delete from messages where chain_key=?').run(chainKey);
  }

  // Delete messages whose owning reply-chain is no longer present in the live DB (whole-chain
  // deletion / compaction-elided). liveChainKeys = every message-store key currently live.
  // Caller manages the transaction (this runs inside applyIncremental's BEGIN/COMMIT).
  deleteMessagesForMissingChains(liveChainKeys: Set<string>) {
    this.db.exec('create temp table if not exists _live_chains(k text primary key)');
    this.db.exec('delete from _live_chains');
    const ins = this.q('insert or ignore into _live_chains values(?)');
    for (const k of liveChainKeys) ins.run(k);
    this.db.exec('delete from messages where chain_key not in (select k from _live_chains)');
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
  }
}
