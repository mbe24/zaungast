import {
  loadEntries,
  decodePrefix,
  readStringWithLength,
  readVarint,
  utf16be,
  decodeValue,
  fingerprint,
} from '../format/index.js';

// Propose-only schema recovery: when a Teams update changes the DB layout (unknown
// fingerprint), sample the raw stores and propose a field mapping for a human to verify and
// save as src/schema/versions/teams-<ver>.json. NEVER applies anything itself.

interface StoreInfo {
  key: string;
  dbId: number;
  dbName: string;
  dbNorm: string;
  store: string;
  count: number;
  sampled: number;
  fields: Set<string>;
  nested?: Set<string>;
  nestedUnder?: string;
}

const normalizeDbName = (n: string) =>
  n
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/:[a-z]{2}-[a-z]{2}$/i, ':<locale>')
    .replace(/:\d+:/g, ':<n>:')
    .replace(/_\d+_/g, '_<n>_');

// logical field → candidate source names, best-match wins
const MSG_FIELDS: Record<string, string[]> = {
  id: ['id', 'messageId', 'clientMessageId'],
  content: ['content', 'body', 'text', 'messageContent'],
  senderName: ['imDisplayName', 'fromDisplayName', 'senderDisplayName', 'author', 'from'],
  senderId: ['creator', 'fromUserId', 'senderId', 'sender', 'from'],
  time: [
    'originalArrivalTime',
    'composeTime',
    'clientArrivalTime',
    'createdTime',
    'timestamp',
    'arrivalTime',
  ],
  conversationId: ['conversationId', 'threadId'],
  messageType: ['messageType', 'contentType', 'type'],
};
const CONV_FIELDS: Record<string, string[]> = {
  id: ['id', 'conversationId', 'threadId'],
  topic: ['topic', 'title', 'threadTopic', 'displayName', 'spaceThreadTopic'],
  threadType: ['threadType', 'type'],
};

function pick(fields: Set<string>, candidates: string[]): string | null {
  for (const c of candidates) if (fields.has(c)) return c;
  return null;
}
function proposeEntity(
  fields: Set<string>,
  spec: Record<string, string[]>,
): { map: Record<string, string>; hits: number } {
  const map: Record<string, string> = {};
  let hits = 0;
  for (const [logical, cands] of Object.entries(spec)) {
    const f = pick(fields, cands);
    if (f) {
      map[logical] = f;
      hits++;
    }
  }
  return { map, hits };
}

export function describeSchema(dir: string, args: any = {}): string {
  const { live } = loadEntries(dir);
  const fp = fingerprint(live);

  const dbNames = new Map<number, string>();
  const storeNames = new Map<string, string>();
  for (const { key, value } of live) {
    if (key.length < 1) continue;
    let p: any;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    if (
      p.databaseId === 0 &&
      p.objectStoreId === 0 &&
      p.indexId === 0 &&
      key[p.headerLen] === 0xc9
    ) {
      const [, p2] = readStringWithLength(key, p.headerLen + 1);
      const [name] = readStringWithLength(key, p2);
      const [id] = readVarint(value, 0);
      dbNames.set(id, name);
    } else if (
      p.databaseId > 0 &&
      p.objectStoreId === 0 &&
      p.indexId === 0 &&
      key[p.headerLen] === 0x32
    ) {
      const [osId, pp] = readVarint(key, p.headerLen + 1);
      if (key[pp] === 0) storeNames.set(`${p.databaseId}:${osId}`, utf16be(value));
    }
  }

  const CAP = 8;
  const stores = new Map<string, StoreInfo>();
  for (const { key, value } of live) {
    let p: any;
    try {
      p = decodePrefix(key);
    } catch {
      continue;
    }
    if (p.indexId !== 1) continue;
    const sk = `${p.databaseId}:${p.objectStoreId}`;
    let info = stores.get(sk);
    if (!info) {
      const dbName = dbNames.get(p.databaseId) ?? `db${p.databaseId}`;
      info = {
        key: sk,
        dbId: p.databaseId,
        dbName,
        dbNorm: normalizeDbName(dbName),
        store: storeNames.get(sk) ?? '?',
        count: 0,
        sampled: 0,
        fields: new Set(),
      };
      stores.set(sk, info);
    }
    info.count++;
    if (info.sampled < CAP) {
      info.sampled++;
      try {
        const obj = decodeValue(value);
        if (obj && typeof obj === 'object') {
          for (const k of Object.keys(obj)) info.fields.add(k);
          // conversation topics live under threadProperties — surface those keys too
          const tp = (obj as any).threadProperties;
          if (tp && typeof tp === 'object') for (const k of Object.keys(tp)) info.fields.add(k);
          // detect a message-map container (records that hold many sub-messages). Union the
          // first few entries per container — the first can be a control/typing/sparse entry
          // missing the fields the mapping references.
          for (const container of ['messageMap', 'messages']) {
            const c = (obj as any)[container];
            if (c && typeof c === 'object' && !Array.isArray(c)) {
              for (const entry of Object.values(c).slice(0, 3)) {
                if (entry && typeof entry === 'object') {
                  info.nested ??= new Set();
                  info.nestedUnder = container;
                  for (const k of Object.keys(entry as object)) info.nested.add(k);
                }
              }
            }
          }
        }
      } catch {
        /* skip undecodable sample */
      }
    }
  }

  const all = [...stores.values()].sort((a, b) => b.count - a.count);

  // score candidates
  const msgCand = all
    .map((s) => ({ s, p: proposeEntity(s.nested ?? s.fields, MSG_FIELDS) }))
    .filter((x) => x.p.hits >= 3 && x.p.map.content)
    .sort((a, b) => b.p.hits - a.p.hits);
  const convScore = (x: any) =>
    x.p.hits +
    (/^conversations?$/i.test(x.s.store) ? 100 : /conversation/i.test(x.s.store) ? 10 : 0);
  const convCand = all
    .map((s) => ({ s, p: proposeEntity(s.fields, CONV_FIELDS) }))
    .filter((x) => x.p.hits >= 2 && (x.p.map.topic || /conversation/i.test(x.s.store)))
    .sort((a, b) => convScore(b) - convScore(a));

  // Fields any proposal might reference — pin these to the FRONT of the printed list so a
  // truncation can never hide exactly the paths the proposal maps (that's what made the old
  // output read as "you mapped fields that don't exist").
  const INTEREST = new Set([
    ...Object.values(MSG_FIELDS).flat(),
    ...Object.values(CONV_FIELDS).flat(),
  ]);
  const showFields = (set: Set<string>): string => {
    const arr = [...set];
    return (
      [...arr.filter((f) => INTEREST.has(f)), ...arr.filter((f) => !INTEREST.has(f))]
        .slice(0, 24)
        .join(', ') || '(none decoded)'
    );
  };

  const lines: string[] = [];
  lines.push(`fingerprint ${fp.hash} · ${dbNames.size} databases · ${all.length} data stores`);
  lines.push('', 'Top data stores (by record count):');
  for (const s of all.slice(0, Number(args.limit) || 20)) {
    lines.push(`  ${s.store} (${s.dbNorm})  ${s.count} recs`);
    if (s.nestedUnder) {
      // Show BOTH levels, labeled — the proposal's iterate/keep reference the record level while
      // content/sender/time live in the nested entries; a verifier needs to see where each lives.
      lines.push(
        `     record fields: ${showFields(s.fields)}`,
        `     per ${s.nestedUnder}.* entry: ${showFields(s.nested!)}`,
      );
    } else {
      lines.push(`     fields: ${showFields(s.fields)}`);
    }
  }

  const buildEntity = (cand: any, iterate?: string) => {
    if (!cand) return null;
    const e: any = {
      db: `*${cand.s.dbNorm.replace(/^Teams:/, '').split(':')[0]}*`,
      store: cand.s.store,
      fields: cand.p.map,
    };
    if (iterate) {
      e.iterate = `${iterate}.*`;
      e.keep = { field: 'type', equals: 'Message' };
    }
    return e;
  };
  const proposal: any = {
    schemaVersion: 'teams-PROPOSED',
    knownFingerprints: [fp.hash],
    match: { requireStores: [] },
    entities: {},
  };
  if (msgCand[0]) {
    proposal.entities.message = buildEntity(msgCand[0], msgCand[0].s.nestedUnder);
    proposal.match.requireStores.push(msgCand[0].s.store);
  }
  if (convCand[0]) {
    proposal.entities.conversation = buildEntity(convCand[0]);
    proposal.match.requireStores.push(convCand[0].s.store);
  }

  lines.push(
    '',
    'PROPOSED mapping (VERIFY before saving to src/schema/versions/teams-<ver>.json):',
    JSON.stringify(proposal, null, 2),
    '',
    'This is a proposal only — nothing was applied. Confirm the field paths against real records, then add the file and restart.',
  );
  return lines.join('\n');
}
