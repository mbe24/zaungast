// Propose-only schema recovery (the ALGORITHM; presentation lives in the MCP describe_schema tool).
// When a Teams update changes the DB layout (unknown fingerprint), sample the raw stores and
// PROPOSE a field mapping for a human to verify and save as src/schema/versions/teams-<ver>.json.
// NEVER applies anything — this only produces a proposal object + the sampled store summaries.
//
// This is schema/domain knowledge (candidate field names, db-name normalization, scoring), so it
// belongs library-side beside the schema layer (fingerprint/resolver/sample) rather than in the
// MCP tool. The structural field walk itself is `sampleStoreFields` (sample.ts); this adds the
// normalized db name, candidate matching, scoring, and proposal assembly. (Q1)
import { fingerprint } from './fingerprint.js';
import { sampleStoreFields } from './sample.js';
import type { Snapshot } from './types.js';

// A sampled store's structural summary + the normalized db name (a `StoreFieldSample` with `dbNorm`).
export interface ProposedStore {
  dbName: string;
  dbNorm: string;
  store: string;
  count: number;
  sampled: number;
  fields: Set<string>;
  nested?: Set<string>;
  nestedUnder?: string;
}

// The full propose-only result: the fingerprint + db/store counts, the sampled stores (by count
// desc), the assembled PROPOSED mapping object, and the set of fields any proposal might reference
// (so a renderer can front-load exactly the mapped paths). Data only — no output text.
export interface SchemaProposal {
  fingerprint: string;
  dbCount: number;
  stores: ProposedStore[];
  proposal: unknown;
  interest: Set<string>;
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
    mappingVersion: '0.0.0-proposed',
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

// Sample the snapshot's stores and PROPOSE a mapping. `cap` bounds the per-store record sample.
export function proposeSchema(snap: Snapshot, opts: { cap?: number } = {}): SchemaProposal {
  const fp = fingerprint(snap);
  // Per-store record counts + structural field sample from sampleStoreFields; add the normalized
  // db name. Sorted by record count desc (biggest stores first — the entity candidates).
  const stores: ProposedStore[] = [...sampleStoreFields(snap, { cap: opts.cap ?? 8 }).values()]
    .map((s) => ({
      dbName: s.dbName,
      dbNorm: normalizeDbName(s.dbName),
      store: s.store,
      count: s.count,
      sampled: s.sampled,
      fields: s.fields,
      nested: s.nested,
      nestedUnder: s.nestedUnder,
    }))
    .sort((a, b) => b.count - a.count);

  // score candidates
  const msgCand = stores
    .map((s) => ({ s, p: proposeEntity(s.nested ?? s.fields, MSG_FIELDS) }))
    .filter((x) => x.p.hits >= 3 && x.p.map.content)
    .sort((a, b) => b.p.hits - a.p.hits);
  const convScore = (x: any) => x.p.hits + conversationNameBonus(x.s.store);
  const convCand = stores
    .map((s) => ({ s, p: proposeEntity(s.fields, CONV_FIELDS) }))
    .filter((x) => x.p.hits >= 2 && (x.p.map.topic || /conversation/i.test(x.s.store)))
    .sort((a, b) => convScore(b) - convScore(a));

  const interest = new Set([
    ...Object.values(MSG_FIELDS).flat(),
    ...Object.values(CONV_FIELDS).flat(),
  ]);

  return {
    fingerprint: fp.hash,
    dbCount: snap.dbNames.size,
    stores,
    proposal: buildProposal(fp.hash, msgCand, convCand),
    interest,
  };
}
