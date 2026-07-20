// G2 — MCP rendered-output golden. Captures the exact token-economical text the tools produce
// over the synthetic fixture, so the Phase-B `tools.ts` dissolve (data→library query API,
// render→MCP) can be proven byte-identical. Fixture is FAKE data (safe to commit).
//
// DETERMINISM: tool output embeds the wall clock (envelope `as_of`, fmtTs year-elision + local
// getHours(), parseTime default now) and local timezone. To make a committed golden stable we
//   (1) force TZ=UTC by re-exec'ing ourselves under that env if not already set, and
//   (2) freeze the clock (Date.now()/no-arg `new Date()`) to a fixed instant after all fixture data,
//   (3) pass absolute ISO since/until (never relative windows) wherever a tool has a now-relative
//       default (rank_topics, list_events, list_calls).
// A startup guard asserts the timezone really is UTC, so a misconfigured run fails loudly rather
// than writing a machine-specific golden.
//
// Run:  node --experimental-sqlite --import tsx test/golden/mcp.ts          (verify vs golden)
//       UPDATE_GOLDEN=1 node --experimental-sqlite --import tsx test/golden/mcp.ts   (rewrite golden)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// (1) Guarantee TZ=UTC by re-exec (imports above are hoisted but do no clock work at load time;
// the child re-runs everything with TZ set from process start, which is what Date/tzset need).
if (process.env.TZ !== 'UTC') {
  const r = spawnSync(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, TZ: 'UTC' },
  });
  process.exit(r.status ?? 1);
}

// (2) Freeze the clock to a fixed instant strictly after all fixture data (BASE_TS = 2026-03-02).
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

const { openStore } = await import('libzaungast');
const {
  listConversations,
  readConversation,
  readThread,
  getMessage,
  search,
  rankTopics,
  findPerson,
  listEvents,
  listCalls,
} = await import('zaungast/tools.js');
const { generateFixtureWithTables } = await import('../../../libzaungast/test/fixture/generate.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'mcp.golden.txt');

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};

// Startup determinism guard: the timezone MUST be UTC or the golden is machine-specific.
ok(
  'timezone is UTC (getTimezoneOffset === 0)',
  new Date(0).getTimezoneOffset() === 0,
  'set TZ=UTC',
);

// Wide absolute bounds (mirrors scripts/profile.mjs) so time-windowed tools are now-independent.
const SINCE = '2020-01-01';
const UNTIL = '2030-01-01';

function render(dir: string): string {
  // The static facade handle IS a StoreView (namespaces + meta); the tools accept it directly (a
  // static store has no `mayBeStale`, so the envelope reads as not-stale — same as the old d=false).
  const store = openStore(dir);

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

  add('list_conversations {n:5}', listConversations(store, { n: 5 }));
  add(
    'list_conversations {kind:"channel", n:4}',
    listConversations(store, { kind: 'channel', n: 4 }),
  );
  if (direct)
    add(
      `read_conversation {conversation:"${direct.handle}", limit:6}`,
      readConversation(store, { conversation: direct.handle, limit: 6 }),
    );
  if (chan) {
    add(
      `read_conversation {conversation:"${chan.handle}", limit:40} (channel digest)`,
      readConversation(store, { conversation: chan.handle, limit: 40 }),
    );
    add(
      `read_conversation {conversation:"${chan.handle}", reactions:"full"}`,
      readConversation(store, { conversation: chan.handle, limit: 40, reactions: 'full' }),
    );
    if (threadRootId) {
      add(
        `read_thread {conversation:"${chan.handle}", thread:"m:${threadRootId}"}`,
        readThread(store, { conversation: chan.handle, thread: `m:${threadRootId}` }),
      );
      // get_message: full single-message render. The thread root has no pivot pointer (rootId===id);
      // a reply (rootId!==id) shows the "in thread …" pivot. Exercises the full-body envelope.
      add(
        `get_message {conversation:"${chan.handle}", message:"m:${threadRootId}"} (thread root)`,
        getMessage(store, { conversation: chan.handle, message: `m:${threadRootId}` }),
      );
      const cm2 = store.messages.inConversation(chan.id, { limit: 500 });
      const reply = cm2.ok ? cm2.rows.find((r) => r.rootId !== r.id) : undefined;
      if (reply)
        add(
          `get_message {conversation:"${chan.handle}", message:"m:${reply.id}"} (reply → pivot)`,
          getMessage(store, { conversation: chan.handle, message: `m:${reply.id}` }),
        );
    }
  }
  add('search {query:"the", limit:10}', search(store, { query: 'the', limit: 10 }));
  add('search {mentions_me:true, limit:6}', search(store, { mentions_me: true, limit: 6 }));
  add(
    'rank_topics {since,until (all), n:6}',
    rankTopics(store, { since: SINCE, until: UNTIL, n: 6 }),
  );
  add('find_person {} (roster)', findPerson(store, {}));
  add(
    'list_events {since,until (all)}',
    listEvents(store, { since: SINCE, until: UNTIL, limit: 30 }),
  );
  add(
    'list_calls {since,until (all)}',
    listCalls(store, { since: SINCE, until: UNTIL, limit: 30 }),
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

const out = withFixture(render);

// (self-check) a second independent run must be byte-identical.
const out2 = withFixture(render);
ok('MCP output is deterministic across two runs', out === out2, 'nondeterministic render');

if (process.env.UPDATE_GOLDEN) {
  fs.writeFileSync(GOLDEN, out);
  console.log(`  wrote golden (${out.length} bytes) → ${path.relative(process.cwd(), GOLDEN)}`);
  ok('golden written', true);
} else {
  const have = fs.existsSync(GOLDEN) ? fs.readFileSync(GOLDEN, 'utf8') : null;
  if (have === null) {
    ok('golden exists', false, 'run once with UPDATE_GOLDEN=1');
  } else if (have === out) {
    ok('MCP output matches committed golden', true);
  } else {
    // find the first differing line to make failures actionable
    const a = have.split('\n'),
      b = out.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    ok(
      'MCP output matches committed golden',
      false,
      `first diff at line ${i + 1}:\n    golden: ${JSON.stringify(a[i])}\n    actual: ${JSON.stringify(b[i])}`,
    );
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
