// MCP rendered-output golden. Captures the exact token-economical text the tools produce
// over the synthetic fixture, so the Phase-B `tools.ts` dissolve (data→library query API,
// render→MCP) can be proven byte-identical. Fixture is FAKE data (safe to commit).
//
// DETERMINISM: tool output embeds the render timezone + a "now" (envelope `as_of`, fmtTs year-elision,
// relative-time defaults). We make the committed golden stable by:
//   (1) passing an explicit RenderCtx { tz:'UTC', now:FIXED } to every tool — the render layer is a
//       pure function of it, so output no longer depends on the process timezone/clock,
//   (2) freezing the clock (FrozenDate) — needed ONLY because meta.asOf is stamped Date.now() during
//       ingest (in libzaungast), which RenderCtx doesn't reach; the render itself uses ctx.now,
//   (3) passing absolute ISO since/until (never relative windows) for the time-windowed tools.
//
// Run:  npx vitest run packages/zaungast/test/golden/mcp.golden.ts
//       npx vitest run -u packages/zaungast/test/golden/mcp.golden.ts   (rewrite the golden)
import { test, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from 'libzaungast';
// Engine selection honors ZAUNGAST_ENGINE (native.yml runs this golden with ZAUNGAST_ENGINE=native to
// prove native output == the JS-generated goldens, exercising createNativeEngine → loader → FFI).
import { selectEngine } from 'zaungast/engine.js';
import {
  listConversations,
  readConversation,
  readThread,
  getMessage,
  search,
  rankTopics,
  findPerson,
  listEvents,
  listCalls,
} from 'zaungast/tools.js';
import { generateFixtureWithTables } from '../../../libzaungast/test/fixture/generate.js';

// A fixed instant strictly after all fixture data (BASE_TS = 2026-03-02): serves as the RenderCtx
// `now` AND the FrozenDate that pins meta.asOf (stamped at ingest time, outside RenderCtx's reach).
const FIXED = Date.UTC(2026, 5, 1, 12, 0, 0); // 2026-06-01T12:00:00.000Z
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(FIXED);
    // @ts-expect-error forward the real Date overloads
    else super(...args);
  }
  static now() {
    return FIXED;
  }
}
(globalThis as unknown as { Date: typeof Date }).Date = FrozenDate as unknown as typeof Date;

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'mcp.golden.txt');

// Wide absolute bounds (mirrors scripts/profile.mjs) so time-windowed tools are now-independent.
const SINCE = '2020-01-01';
const UNTIL = '2030-01-01';

// Explicit render context: UTC + the frozen instant, threaded into every tool call so the golden is
// timezone-independent (no ambient process.env.TZ). Production builds this per-dispatch in server.ts.
const CTX = { tz: 'UTC', now: FIXED };

let engine: Awaited<ReturnType<typeof selectEngine>>['engine'];
beforeAll(async () => {
  ({ engine } = await selectEngine());
});

function render(dir: string): string {
  // The static facade handle IS a StoreView (namespaces + meta); the tools accept it directly (a
  // static store has no `mayBeStale`, so the envelope reads as not-stale — same as the old d=false).
  const store = openStore(dir, { engine });

  // The fixture holds exactly one channel and one 1:1 (see the golden), so these picks are unique
  // regardless of ordering. The earliest thread root = the first (ts,id-ascending) root message.
  const chan = store.conversations.list({ kind: 'channel', n: 1 })[0];
  const direct = store.conversations.list({ kind: '1:1', n: 1 })[0];
  let threadRootId: string | undefined;
  if (chan) {
    const cm = store.messages.inConversation(chan.id, { limit: 500 });
    if (cm.ok) threadRootId = cm.rows.find((r) => r.rootId === r.id)?.id;
  }

  const parts: string[] = [];
  const add = (label: string, out: string) => parts.push(`########## ${label} ##########\n${out}`);

  add('list_conversations {n:5}', listConversations(store, { n: 5 }, CTX));
  add(
    'list_conversations {kind:"channel", n:4}',
    listConversations(store, { kind: 'channel', n: 4 }, CTX),
  );
  if (direct)
    add(
      `read_conversation {conversation:"${direct.handle}", limit:6}`,
      readConversation(store, { conversation: direct.handle, limit: 6 }, CTX),
    );
  if (chan) {
    add(
      `read_conversation {conversation:"${chan.handle}", limit:40} (channel digest)`,
      readConversation(store, { conversation: chan.handle, limit: 40 }, CTX),
    );
    add(
      `read_conversation {conversation:"${chan.handle}", reactions:"full"}`,
      readConversation(store, { conversation: chan.handle, limit: 40, reactions: 'full' }, CTX),
    );
    if (threadRootId) {
      add(
        `read_thread {conversation:"${chan.handle}", thread:"m:${threadRootId}"}`,
        readThread(store, { conversation: chan.handle, thread: `m:${threadRootId}` }, CTX),
      );
      // get_message: full single-message render. The thread root has no pivot pointer (rootId===id);
      // a reply (rootId!==id) shows the "in thread …" pivot. Exercises the full-body envelope.
      add(
        `get_message {conversation:"${chan.handle}", message:"m:${threadRootId}"} (thread root)`,
        getMessage(store, { conversation: chan.handle, message: `m:${threadRootId}` }, CTX),
      );
      const cm2 = store.messages.inConversation(chan.id, { limit: 500 });
      const reply = cm2.ok ? cm2.rows.find((r) => r.rootId !== r.id) : undefined;
      if (reply)
        add(
          `get_message {conversation:"${chan.handle}", message:"m:${reply.id}"} (reply → pivot)`,
          getMessage(store, { conversation: chan.handle, message: `m:${reply.id}` }, CTX),
        );
    }
  }
  add('search {query:"the", limit:10}', search(store, { query: 'the', limit: 10 }, CTX));
  add('search {mentions_me:true, limit:6}', search(store, { mentions_me: true, limit: 6 }, CTX));
  add(
    'rank_topics {since,until (all), n:6}',
    rankTopics(store, { since: SINCE, until: UNTIL, n: 6 }, CTX),
  );
  add('find_person {} (roster)', findPerson(store, {}, CTX));
  add(
    'list_events {since,until (all)}',
    listEvents(store, { since: SINCE, until: UNTIL, limit: 30 }, CTX),
  );
  add(
    'list_calls {since,until (all)}',
    listCalls(store, { since: SINCE, until: UNTIL, limit: 30 }, CTX),
  );

  store.close();
  return parts.join('\n\n') + '\n';
}

function withFixture<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zaungast-g2-'));
  try {
    generateFixtureWithTables(dir);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('MCP rendered output is deterministic and matches the committed golden', async () => {
  const out = withFixture(render);
  const out2 = withFixture(render); // a second independent run must be byte-identical
  expect(out, 'nondeterministic render').toBe(out2);
  await expect(out).toMatchFileSnapshot(GOLDEN);
});
