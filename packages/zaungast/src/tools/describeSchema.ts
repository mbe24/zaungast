import { fingerprint, sampleStoreFields } from 'libzaungast/format';
import type { Snapshot } from 'libzaungast/format/engine';

// Propose-only schema recovery: when a Teams update changes the DB layout (unknown
// fingerprint), sample the raw stores and propose a field mapping for a human to verify and
// save as src/schema/versions/teams-<ver>.json. NEVER applies anything itself.
//
// The STRUCTURAL field walk (record keys + threadProperties + messageMap/messages sub-entries)
// now lives library-side in `sampleStoreFields` (so the raw value decoder stays internal); this
// module keeps ALL the propose-only POLICY — db-name normalization, candidate matching, scoring,
// proposal assembly, and output text.

// A sampled store's structural summary + the MCP's normalized db name. Maps from the library's
// StoreFieldSample (store/dbName/count/sampled/fields/nested/nestedUnder) with `dbNorm` added.
interface StoreInfo {
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

// A store literally named "conversation(s)" is almost certainly the conversation entity even
// with a mediocre field-hit count; a store whose name merely mentions "conversation" is a
// weaker signal; anything else relies on field hits alone.
function conversationNameBonus(storeName: string): number {
  if (/^conversations?$/i.test(storeName)) return 100;
  if (/conversation/i.test(storeName)) return 10;
  return 0;
}

// Per-object-store record counts + a structural field sample (up to cap=8 records) come from the
// library's `sampleStoreFields`; the MCP only adds its normalized db name (`dbNorm`).
function sampleStores(snap: Snapshot): StoreInfo[] {
  return [...sampleStoreFields(snap, { cap: 8 }).values()].map((s) => ({
    dbName: s.dbName,
    dbNorm: normalizeDbName(s.dbName),
    store: s.store,
    count: s.count,
    sampled: s.sampled,
    fields: s.fields,
    nested: s.nested,
    nestedUnder: s.nestedUnder,
  }));
}

// Fields any proposal might reference are pinned to the FRONT of the printed list so a
// truncation can never hide exactly the paths the proposal maps (that's what made the old
// output read as "you mapped fields that don't exist").
function showFields(set: Set<string>, interest: Set<string>): string {
  const arr = [...set];
  return (
    [...arr.filter((f) => interest.has(f)), ...arr.filter((f) => !interest.has(f))]
      .slice(0, 24)
      .join(', ') || '(none decoded)'
  );
}

// Render the "Top data stores (by record count):" section, one entry per store (record-level
// fields, plus — when a message-map container was found — the nested per-entry fields too).
function renderStoreList(all: StoreInfo[], limit: number, interest: Set<string>): string[] {
  const lines: string[] = [];
  for (const s of all.slice(0, limit)) {
    lines.push(`  ${s.store} (${s.dbNorm})  ${s.count} recs`);
    if (s.nestedUnder) {
      // Show BOTH levels, labeled — the proposal's iterate/keep reference the record level while
      // content/sender/time live in the nested entries; a verifier needs to see where each lives.
      lines.push(
        `     record fields: ${showFields(s.fields, interest)}`,
        `     per ${s.nestedUnder}.* entry: ${showFields(s.nested!, interest)}`,
      );
    } else {
      lines.push(`     fields: ${showFields(s.fields, interest)}`);
    }
  }
  return lines;
}

function buildEntity(cand: any, iterate?: string): any {
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
}

// Assemble the propose-only mapping object: best message/conversation candidates (if any),
// keyed by the entity name the resolver expects.
function buildProposal(fpHash: string, msgCand: any[], convCand: any[]): any {
  const proposal: any = {
    schemaVersion: 'teams-PROPOSED',
    knownFingerprints: [fpHash],
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
  return proposal;
}

export function describeSchema(snap: Snapshot, args: any = {}): string {
  const fp = fingerprint(snap);

  const all = sampleStores(snap).sort((a, b) => b.count - a.count);

  // score candidates
  const msgCand = all
    .map((s) => ({ s, p: proposeEntity(s.nested ?? s.fields, MSG_FIELDS) }))
    .filter((x) => x.p.hits >= 3 && x.p.map.content)
    .sort((a, b) => b.p.hits - a.p.hits);
  const convScore = (x: any) => x.p.hits + conversationNameBonus(x.s.store);
  const convCand = all
    .map((s) => ({ s, p: proposeEntity(s.fields, CONV_FIELDS) }))
    .filter((x) => x.p.hits >= 2 && (x.p.map.topic || /conversation/i.test(x.s.store)))
    .sort((a, b) => convScore(b) - convScore(a));

  const interest = new Set([
    ...Object.values(MSG_FIELDS).flat(),
    ...Object.values(CONV_FIELDS).flat(),
  ]);

  const lines: string[] = [];
  lines.push(`fingerprint ${fp.hash} · ${snap.dbNames.size} databases · ${all.length} data stores`);
  lines.push('', 'Top data stores (by record count):');
  lines.push(...renderStoreList(all, Number(args.limit) || 20, interest));

  const proposal = buildProposal(fp.hash, msgCand, convCand);
  lines.push(
    '',
    'PROPOSED mapping (VERIFY before saving to src/schema/versions/teams-<ver>.json):',
    JSON.stringify(proposal, null, 2),
    '',
    'This is a proposal only — nothing was applied. Confirm the field paths against real records, then add the file and restart.',
  );
  return lines.join('\n');
}
