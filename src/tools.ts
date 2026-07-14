import { isBotMri, type ChatStore, type StoreMeta } from './ingest/store.js';
import { makeExtractor } from './util/topics.js';
import { byCodeUnit } from './util/sort.js';
import type {
  ListConversationsArgs,
  ReadMessagesArgs,
  SearchArgs,
  TopTopicsArgs,
  FindPersonArgs,
} from './schemas.js';

type DB = ChatStore['db'];

// ---------- formatting ----------
const pad = (n: number) => String(n).padStart(2, '0');
export function fmtTs(ts: number): string {
  if (!ts) return '--';
  const d = new Date(ts);
  const now = new Date();
  const y = d.getFullYear() !== now.getFullYear() ? `${d.getFullYear()}-` : '';
  return `${y}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function envelope(meta: StoreMeta, deferred: boolean, extra = ''): string {
  const tz = -new Date().getTimezoneOffset() / 60;
  const stale = deferred ? ' · data:may-be-stale' : '';
  const lossy = (meta as any).lossy ? ' · data:incomplete(source-partially-unreadable)' : '';
  return `as_of ${fmtTs(meta.asOf)} (tz${tz >= 0 ? '+' : ''}${tz})${stale}${lossy}${extra ? ' · ' + extra : ''}`;
}
export function parseTime(s: string | number | undefined, now = Date.now()): number | undefined {
  if (s == null) return undefined;
  if (typeof s === 'number') return s;
  const rel = /^-(\d+)([dhm])$/.exec(s.trim());
  if (rel) {
    const n = +rel[1];
    const u = rel[2];
    return now - n * (u === 'd' ? 864e5 : u === 'h' ? 36e5 : 6e4);
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
}
// Reject unparseable time filters loudly instead of silently ignoring them.
function badTime(args: any, keys: string[]): string | null {
  for (const k of keys)
    if (args[k] != null && parseTime(args[k]) === undefined)
      return `error: cannot parse ${k}="${args[k]}" — use ISO (2026-07-01) or relative (-7d / -24h / -30m)`;
  return null;
}
// Build a safe FTS5 MATCH string: quote each term so user punctuation/operators can't
// throw a syntax error. Returns null if there's nothing to match.
function ftsMatch(raw: string): string | null {
  const toks = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return toks.length ? toks.map((t) => `"${t}"`).join(' ') : null;
}
// Truncate with an ellipsis marker so the agent can tell a message was cut.
function clip(s: string, n: number): string {
  s = (s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// escape LIKE wildcards in user input (used with `escape '\'`)
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}

// ---------- resolvers (name/handle → ids) ----------
function convIdsFor(db: DB, arg: string): string[] {
  if (arg.startsWith('c:')) {
    const r = db.prepare('select id from conversations where handle=?').get(arg) as any;
    return r ? [r.id] : [];
  }
  const like = `%${likeEscape(arg)}%`;
  return (
    db
      .prepare(
        `select id from conversations where topic like ? escape '\\' or participant_names like ? escape '\\'`,
      )
      .all(like, like) as any[]
  ).map((r) => r.id);
}
function senderFilter(db: DB, arg: string): { sql: string; params: any[]; miss?: string } {
  if (arg.startsWith('p:')) {
    const r = db.prepare('select mri from people where handle=?').get(arg) as any;
    if (!r) return { sql: '1=0', params: [], miss: `no person matches ${arg}` };
    return { sql: 'm.sender_mri=?', params: [r.mri] };
  }
  return { sql: "m.sender_name like ? escape '\\'", params: [`%${likeEscape(arg)}%`] };
}

// Resolve an `exclude` list into conversation ids / sender MRIs / plain words. Handles fail
// loudly (return .miss) so a typo'd handle never silently excludes nothing.
function resolveExcludes(
  db: DB,
  list: string[] | undefined,
): { convIds: string[]; mris: string[]; words: string[]; miss?: string } {
  const convIds: string[] = [],
    mris: string[] = [],
    words: string[] = [];
  for (const raw of list ?? []) {
    const e = String(raw).trim();
    if (!e) continue;
    if (e.startsWith('c:')) {
      const r = db.prepare('select id from conversations where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: `exclude: no conversation ${e}` };
      convIds.push(r.id);
    } else if (e.startsWith('p:')) {
      const r = db.prepare('select mri from people where handle=?').get(e) as any;
      if (!r) return { convIds, mris, words, miss: `exclude: no person ${e}` };
      mris.push(r.mri);
    } else words.push(e.toLowerCase());
  }
  return { convIds, mris, words };
}

// Local-cache coverage for a scope (min/max message ts, system msgs excluded) — surfaced on
// empty/edge results so "0 hits" isn't misread as "quiet" when the cache simply hasn't synced
// anything that recent. Claims only what the cache knows ("newest cached"), never "quiet".
function coverageNote(db: DB, scopeSql: string, scopeParams: any[]): string {
  const r = db
    .prepare(`select min(m.ts) lo, max(m.ts) hi from messages m where ${scopeSql} and m.ts>0`)
    .get(...scopeParams) as any;
  if (!r || !r.hi) return 'no cached messages in this scope';
  return `newest cached in this scope: ${fmtTs(r.hi)} · oldest ${fmtTs(r.lo)} — local cache may lag the server`;
}
// A conversation title-substring that matches >1 conversation → non-blocking disambiguation note.
function convAmbiguityNote(db: DB, arg: string, ids: string[]): string {
  if (arg.startsWith('c:') || ids.length <= 1) return '';
  const rows = db
    .prepare(
      `select handle,topic,participant_names from conversations where id in (${ids.map(() => '?').join(',')}) order by last_ts desc limit 4`,
    )
    .all(...ids) as any[];
  return `note: in:"${arg}" matched ${ids.length} conversations (${rows.map((r) => `${r.handle} ${r.topic || r.participant_names || ''}`.trim()).join(', ')}) — searching all; pass a c:handle to narrow`;
}

// ================= TOOLS =================

export function listConversations(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ListConversationsArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since']);
  if (bt) return bt;
  const n = Math.min(Number(args.n) || 12, 30);
  const where: string[] = [];
  const params: any[] = [];
  if (!args.include_empty) where.push('msg_count>0'); // hide 0-message team roots by default
  if (args.kind) {
    where.push('kind=?');
    params.push(args.kind);
  }
  if (args.query) {
    where.push('(topic like ? or participant_names like ?)');
    params.push(`%${args.query}%`, `%${args.query}%`);
  }
  if (args.participant) {
    where.push('participant_names like ?');
    params.push(`%${args.participant}%`);
  }
  const since = parseTime(args.since);
  if (since) {
    where.push('last_ts>=?');
    params.push(since);
  }
  const w = where.length ? 'where ' + where.join(' and ') : '';
  const rows = db
    .prepare(
      `select handle,kind,topic,participant_names,last_ts,msg_count
     from conversations ${w} order by last_ts desc limit ?`,
    )
    .all(...params, n) as any[];
  const lines = rows.map((r) => {
    const title = r.topic || r.participant_names || '(untitled)';
    return `${r.handle} [${r.kind}] "${title}" · ${r.msg_count} msg · last ${fmtTs(r.last_ts)}`;
  });
  return `${envelope(meta, deferred, `${rows.length} conversations`)}\n${lines.join('\n') || '(none)'}`;
}

export function readMessages(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: ReadMessagesArgs = {} as ReadMessagesArgs,
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  if (!args.conversation) return 'error: conversation (handle or title substring) is required';
  const ids = convIdsFor(db, String(args.conversation));
  if (!ids.length) return `no conversation matches "${args.conversation}"`;
  if (ids.length > 1 && !String(args.conversation).startsWith('c:')) {
    const cands = db
      .prepare(
        `select handle,kind,topic,participant_names from conversations
      where id in (${ids.map(() => '?').join(',')}) order by last_ts desc limit 8`,
      )
      .all(...ids) as any[];
    return (
      `ambiguous — ${ids.length} conversations match. Pick a handle:\n` +
      cands.map((c) => `  ${c.handle} [${c.kind}] ${c.topic || c.participant_names}`).join('\n')
    );
  }
  const id = ids[0];
  const limit = Math.min(Number(args.limit) || 40, 200);
  const conds = ['conv_id=?', 'is_system=0'];
  const p: any[] = [id];
  const since = parseTime(args.since);
  if (since) {
    conds.push('ts>=?');
    p.push(since);
  }
  const until = parseTime(args.until);
  if (until) {
    conds.push('ts<?');
    p.push(until);
  }
  // cursor `older:<ts>:<id>` — (ts,id) tuple so equal-timestamp neighbours aren't skipped
  const older = args.cursor && /^older:(\d+):(.+)$/.exec(String(args.cursor));
  if (older) {
    conds.push('(ts<? or (ts=? and id<?))');
    p.push(Number(older[1]), Number(older[1]), older[2]);
  }

  let rows: any[];
  if (args.around) {
    const aroundId = String(args.around).replace(/^m:/, '');
    const a = db
      .prepare('select ts from messages where conv_id=? and id=?')
      .get(id, aroundId) as any;
    if (!a) return `message ${args.around} not found in this conversation`;
    const half = Math.floor(limit / 2);
    const before = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts<=? order by ts desc, id desc limit ?`,
      )
      .all(id, a.ts, half) as any[];
    const after = db
      .prepare(
        `select * from messages where conv_id=? and is_system=0 and ts>? order by ts asc, id asc limit ?`,
      )
      .all(id, a.ts, half) as any[];
    rows = [...before.reverse(), ...after];
  } else {
    // last `limit` in the window, rendered oldest→newest (story order)
    rows = (
      db
        .prepare(
          `select * from messages where ${conds.join(' and ')} order by ts desc, id desc limit ?`,
        )
        .all(...p, limit) as any[]
    ).reverse();
  }
  const conv = db
    .prepare('select handle,kind,topic,participant_names from conversations where id=?')
    .get(id) as any;
  const total = (
    db.prepare('select count(*) n from messages where conv_id=? and is_system=0').get(id) as any
  ).n;
  const span = db
    .prepare('select min(ts) lo, max(ts) hi from messages where conv_id=? and is_system=0 and ts>0')
    .get(id) as any;
  const earliest = span?.lo ?? 0,
    newest = span?.hi ?? 0;
  // Only offer an older: cursor when there really are older messages (else the agent pages into nothing).
  const oldest = rows[0];
  const olderCursor = oldest && oldest.ts > earliest ? `older:${oldest.ts}:${oldest.id}` : '';
  // Show both local bounds so a caller knows the cache slice — "newest local" flags when the
  // local cache lags the server (its most recent cached message may be days old).
  const head = `${conv.handle} [${conv.kind}] "${conv.topic || conv.participant_names}" · showing ${rows.length}/${total} · local cache ${fmtTs(earliest)}–${fmtTs(newest)}${olderCursor ? ` · older: ${olderCursor}` : ''}`;
  let lastMri: string | null = null,
    lastTs = 0;
  const lines = rows.map((r) => {
    // collapse consecutive same-sender runs (by MRI, not display name), but reset after a 15-min gap
    const collapsed = r.sender_mri === lastMri && r.ts - lastTs < 15 * 60_000;
    lastMri = r.sender_mri;
    lastTs = r.ts;
    const who = collapsed ? '  ↳' : r.is_mine ? 'ME' : r.sender_name || '(unknown)';
    const marks = (r.has_attach ? ' [attachment]' : '') + (r.mentions_me ? ' [@me]' : '');
    return `${fmtTs(r.ts)} ${who}> ${clip(r.content, 280)}${marks}`;
  });
  return `${envelope(meta, deferred)}\n${head}\n${lines.join('\n') || '(no messages)'}`;
}

export function search(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: SearchArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const limit = Math.min(Number(args.limit) || 20, 60);
  // scopeConds = who/where/kind + excludes (NOT time, NOT the query term) — used for the
  // coverage note so "newest cached" means "in this scope", not "newest matching the query".
  const scopeConds: string[] = ['m.is_system=0'];
  const scopeParams: any[] = [];
  const notes: string[] = [];
  if (args.from) {
    const f = senderFilter(db, String(args.from));
    if (f.miss) return f.miss;
    scopeConds.push(f.sql);
    scopeParams.push(...f.params);
    if (!String(args.from).startsWith('p:')) {
      const ppl = db
        .prepare(
          "select handle,name from people where name like ? escape '\\' order by msg_count desc",
        )
        .all(`%${likeEscape(String(args.from))}%`) as any[];
      if (ppl.length > 1)
        notes.push(
          `note: from:"${args.from}" matched ${ppl.length} people (${ppl
            .slice(0, 4)
            .map((p) => `${p.handle} ${p.name}`)
            .join(', ')}) — pass a p:handle to narrow`,
        );
    }
  }
  if (args.in) {
    const ids = convIdsFor(db, String(args.in));
    if (!ids.length) return `no conversation matches "${args.in}"`;
    scopeConds.push(`m.conv_id in (${ids.map(() => '?').join(',')})`);
    scopeParams.push(...ids);
    const amb = convAmbiguityNote(db, String(args.in), ids);
    if (amb) notes.push(amb);
  }
  if (args.kind) {
    scopeConds.push('m.kind=?');
    scopeParams.push(args.kind);
  }
  if (args.mentions_me) scopeConds.push('m.mentions_me=1');
  if (args.has_attachment) scopeConds.push('m.has_attach=1');
  if (args.exclude?.length) {
    const ex = resolveExcludes(db, args.exclude);
    if (ex.miss) return ex.miss;
    if (ex.convIds.length) {
      scopeConds.push(`m.conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
      scopeParams.push(...ex.convIds);
    }
    if (ex.mris.length) {
      scopeConds.push(`m.sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
      scopeParams.push(...ex.mris);
    }
  }

  const conds = [...scopeConds];
  const params = [...scopeParams];
  const since = parseTime(args.since);
  if (since) {
    conds.push('m.ts>=?');
    params.push(since);
  }
  const until = parseTime(args.until);
  if (until) {
    conds.push('m.ts<?');
    params.push(until);
  }

  const match = args.query && String(args.query).trim() ? ftsMatch(String(args.query)) : null;
  let rows: any[];
  let order: string;
  if (match && meta.ftsEnabled) {
    order = 'relevance';
    rows = db
      .prepare(
        `select m.*, snippet(messages_fts,0,'[',']','…',10) snip
      from messages_fts f join messages m on m.conv_id=f.conv_id and m.id=f.id
      where messages_fts match ? and ${conds.join(' and ')}
      order by bm25(messages_fts) limit ?`,
      )
      .all(match, ...params, limit) as any[];
  } else {
    if (args.query && String(args.query).trim()) {
      conds.push("m.content like ? escape '\\'");
      params.push(`%${likeEscape(String(args.query))}%`);
    }
    order = 'time';
    rows = db
      .prepare(
        `select m.*, substr(m.content,1,120) snip from messages m
      where ${conds.join(' and ')} order by m.ts desc, m.id desc limit ?`,
      )
      .all(...params, limit) as any[];
  }
  const convH = new Map<string, string>();
  const hn = (cid: string) =>
    convH.get(cid) ??
    convH
      .set(
        cid,
        (db.prepare('select handle from conversations where id=?').get(cid) as any)?.handle ?? '?',
      )
      .get(cid)!;
  const distinct = [...new Set(rows.map((r) => r.conv_id))];
  const legend =
    distinct.length <= 5
      ? distinct
          .map(
            (cid) =>
              `${hn(cid)}="${(db.prepare('select topic,participant_names from conversations where id=?').get(cid) as any)?.topic || (db.prepare('select participant_names from conversations where id=?').get(cid) as any)?.participant_names || '?'}"`,
          )
          .join(' · ')
      : '';
  const lines = rows.map(
    (r) =>
      `${hn(r.conv_id)} ${fmtTs(r.ts)} m:${r.id} ${r.is_mine ? 'ME' : r.sender_name}> ${clip(r.snip, 140)}`,
  );

  // Cache-horizon note: on empty results, or when a `since` filter starts after the newest
  // cached message in scope (window entirely uncovered), tell the reader what the cache holds.
  const scopeSql = scopeConds.join(' and ');
  let coverage = '';
  if (rows.length === 0) coverage = coverageNote(db, scopeSql, scopeParams);
  else if (since) {
    const hi =
      (
        db
          .prepare(`select max(m.ts) hi from messages m where ${scopeSql}`)
          .get(...scopeParams) as any
      )?.hi ?? 0;
    if (since > hi) coverage = coverageNote(db, scopeSql, scopeParams);
  }

  const head = [
    envelope(meta, deferred, `order:${order} · ${rows.length} hits`),
    ...notes,
    legend,
    coverage,
  ]
    .filter(Boolean)
    .join('\n');
  return `${head}\n${lines.join('\n') || '(no matches)'}`;
}

export function topTopics(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: TopTopicsArgs = {},
): string {
  const db = store.db;
  const bt = badTime(args, ['since', 'until']);
  if (bt) return bt;
  const n = Math.min(Number(args.n) || 8, 15);
  const notes: string[] = [];

  // name tokens (exclude people names from topics)
  const nameTokens = new Set<string>();
  for (const r of db.prepare('select name from people').all() as any[])
    for (const w of String(r.name || '')
      .toLowerCase()
      .match(/[\p{L}\p{M}]{3,}/gu) || [])
      nameTokens.add(w);
  const { phrases: extract } = makeExtractor(nameTokens); // en+de merged (default)

  // Cache tokenization per message content (the expensive part). Per-call word excludes are
  // applied by FILTERING the cached array after retrieval — never threaded into `extract`, so
  // one call's excludes can't contaminate another's cached phrases.
  const sig = `${nameTokens.size}:${[...nameTokens].sort(byCodeUnit).join(',').length}`;
  if (store.phraseCacheSig !== sig) {
    store.phraseCache.clear();
    store.phraseCacheSig = sig;
  }
  const cache = store.phraseCache;
  const ex = resolveExcludes(db, args.exclude);
  if (ex.miss) return ex.miss;
  const excludeWords = new Set(ex.words);
  const phrases = (content: string): string[] => {
    let p = cache.get(content);
    if (!p) {
      p = extract(content);
      cache.set(content, p);
    }
    return excludeWords.size
      ? p.filter((ph) => !ph.split(' ').some((w) => excludeWords.has(w)))
      : p;
  };

  // scope. A person/1:1 scope inherently has one speaker per phrase, so the ≥2-sender anti-spam
  // gate relaxes to ≥1 there. A conversation scope matching NOTHING must error, not silently
  // fall through to whole-DB topics (P4).
  const conds = ['is_system=0', "content<>''"];
  const params: any[] = [];
  let personScope = false;
  if (args.scope && String(args.scope).startsWith('conversation:')) {
    const term = String(args.scope).slice(13);
    const ids = convIdsFor(db, term);
    if (!ids.length) return `no conversation matches "${term}"`;
    conds.push(`conv_id in (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
    const amb = convAmbiguityNote(db, term, ids);
    if (amb) notes.push(amb.replace('in:', 'scope conversation:'));
  } else if (args.scope && String(args.scope).startsWith('person:')) {
    const f = senderFilter(db, String(args.scope).slice(7));
    if (f.miss) return f.miss;
    conds.push(f.sql.replace('m.', ''));
    params.push(...f.params);
    personScope = true;
  }
  if (ex.convIds.length) {
    conds.push(`conv_id not in (${ex.convIds.map(() => '?').join(',')})`);
    params.push(...ex.convIds);
  }
  if (ex.mris.length) {
    conds.push(`sender_mri not in (${ex.mris.map(() => '?').join(',')})`);
    params.push(...ex.mris);
  }
  const minSenders = personScope ? 1 : 2;

  let all = db
    .prepare(`select ts, sender_mri, content from messages where ${conds.join(' and ')}`)
    .all(...params) as any[];
  // Bots/apps (28: MRI) are excluded by default — automated "updated/status" chatter isn't a
  // topic you discussed. Excluded from BOTH window and baseline so lift isn't skewed.
  let botExcluded = 0;
  if (!args.include_bots) {
    const before = all.length;
    all = all.filter((m) => !isBotMri(m.sender_mri));
    botExcluded = before - all.length;
  }
  if (!all.length) return `${envelope(meta, deferred)}\n(no messages in scope)`;

  // Window: explicit since/until (arbitrary range) overrides the enum. Baseline is always the
  // messages BEFORE the window ("new vs history") — never after — so a topic that persists past
  // the window isn't penalised.
  const explicit = args.since != null || args.until != null;
  let maxTs = 0;
  for (const m of all) if (m.ts > maxTs) maxTs = m.ts;
  const windowMs =
    { '1d': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5 }[String(args.window || '7d')] ?? 7 * 864e5;
  const sinceTs = explicit ? (parseTime(args.since) ?? 0) : maxTs - windowMs;
  const untilTs = explicit
    ? (parseTime(args.until) ?? Number.MAX_SAFE_INTEGER)
    : Number.MAX_SAFE_INTEGER;

  const baseDf = new Map<string, number>();
  let baseTotal = 0;
  for (const m of all)
    if (m.ts < sinceTs) {
      baseTotal++;
      for (const ph of new Set(phrases(m.content))) baseDf.set(ph, (baseDf.get(ph) || 0) + 1);
    }

  const count = new Map<string, number>(),
    df = new Map<string, number>();
  const senders = new Map<string, Set<string>>(),
    example = new Map<string, any>();
  const win = all.filter((m) => m.ts >= sinceTs && m.ts < untilTs);
  for (const m of win) {
    const seen = new Set<string>();
    for (const ph of phrases(m.content)) {
      count.set(ph, (count.get(ph) || 0) + 1);
      if (!seen.has(ph)) {
        df.set(ph, (df.get(ph) || 0) + 1);
        seen.add(ph);
      }
      (senders.get(ph) || senders.set(ph, new Set()).get(ph)!).add(m.sender_mri);
      if (!example.has(ph)) example.set(ph, m);
    }
  }
  const rows = [...count.entries()]
    .map(([ph, c]) => {
      const winRate = df.get(ph)! / Math.max(1, win.length);
      const baseRate = ((baseDf.get(ph) || 0) + 0.5) / (baseTotal + 1);
      return { ph, c, ns: senders.get(ph)!.size, lift: winRate / baseRate, ex: example.get(ph) };
    })
    .filter((r) => r.c >= 3 && r.ns >= minSenders)
    .sort((a, b) => b.lift * Math.log2(1 + b.c) - a.lift * Math.log2(1 + a.c))
    .slice(0, n);

  if (botExcluded)
    notes.push(`excluded ${botExcluded} bot/app msgs · include_bots:true to include`);
  if (baseTotal < 30) notes.push(`baseline sparse (${baseTotal} msgs) — ×baseline is approximate`);
  const windowLabel = explicit
    ? `range ${fmtTs(sinceTs)}..${untilTs === Number.MAX_SAFE_INTEGER ? 'now' : fmtTs(untilTs)}`
    : `window ${args.window || '7d'}`;
  const lines = rows.map(
    (r, i) =>
      `${i + 1}. "${r.ph}" ×${r.c} (${r.lift.toFixed(1)}× baseline) · ${r.ns} people\n   e.g. ${fmtTs(r.ex.ts)}: ${clip(r.ex.content, 90)}`,
  );
  const head = [envelope(meta, deferred, `${windowLabel} · ${win.length} msgs`), ...notes].join(
    '\n',
  );
  return `${head}\n${lines.join('\n') || '(no distinctive topics)'}`;
}

export function findPerson(
  store: ChatStore,
  meta: StoreMeta,
  deferred: boolean,
  args: FindPersonArgs = {},
): string {
  const db = store.db;
  const n = Math.min(Number(args.n) || 8, 25);
  const q = args.query ? String(args.query).trim() : '';
  let rows: any[];
  let header: string;
  if (q.startsWith('p:')) {
    rows = db
      .prepare('select handle,mri,name,msg_count,last_ts from people where handle=?')
      .all(q) as any[];
    if (!rows.length) return `${envelope(meta, deferred)}\nno person with handle ${q}`;
    header = 'profile';
  } else if (q) {
    rows = db
      .prepare(
        "select handle,mri,name,msg_count,last_ts from people where name like ? escape '\\' order by msg_count desc limit ?",
      )
      .all(`%${likeEscape(q)}%`, n) as any[];
    if (!rows.length)
      return `${envelope(meta, deferred)}\nno person matches "${q}" — try a shorter substring, or call find_person with no query to scan the roster.`;
    header = `${rows.length} people match "${q}"`;
  } else {
    rows = db
      .prepare(
        'select handle,mri,name,msg_count,last_ts from people order by msg_count desc limit ?',
      )
      .all(n) as any[];
    header = `roster — top ${rows.length} by volume`;
  }
  const selfMri = (meta as any).selfMri as string | null;
  const lines = rows.map((r) => {
    const tags = `${isBotMri(r.mri) ? ' [bot]' : ''}${selfMri && r.mri === selfMri ? ' (you)' : ''}`;
    return `${r.handle} "${r.name || '(unknown)'}"${tags} · ${r.msg_count} msg · last ${fmtTs(r.last_ts)}`;
  });
  return `${envelope(meta, deferred, header)}\n${lines.join('\n')}`;
}
