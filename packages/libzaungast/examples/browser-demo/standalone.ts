// Standalone (double-click, file://) POC entry — bundled + inlined into a single dist/standalone.html.
// No Web Worker (file:// forbids them), so the build runs on the main thread: the tab is unresponsive
// for the few seconds it takes, and progress can't render live. We DO collect per-phase timings via the
// onPhase hook and show the breakdown when it finishes, behind a "Building…" placeholder painted first.
// The live, per-file progress version is the hosted build (index.html + worker.js), which needs http.
import { openStoreFromSource, MemorySource, type BuildPhase } from 'libzaungast/web';
import { createSqliteWasmDriver } from '../sqlite-wasm-driver.ts';
// esbuild base64 loader → the wasm as a string; passed via `wasmBinary` so nothing is fetched (file://).
// @ts-expect-error — no type decl for the .wasm import under the base64 loader.
import sqlite3WasmBase64 from '@sqlite.org/sqlite-wasm/sqlite3.wasm';

const out = document.getElementById('out') as HTMLPreElement;
const log = (...xs: unknown[]) => {
  out.textContent +=
    xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ') + '\n';
};
const clear = () => (out.textContent = '');
// Let the browser paint queued DOM updates before we hand it a multi-second synchronous build.
const paint = () => new Promise((r) => setTimeout(r, 50));

const wasmBinary = Uint8Array.from(atob(sqlite3WasmBase64 as unknown as string), (c) =>
  c.charCodeAt(0),
);
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () => (driverPromise ??= createSqliteWasmDriver({ wasmBinary }));

/* eslint-disable @typescript-eslint/no-explicit-any */
function render(store: any) {
  log('meta:', store.meta);
  const convs = store.conversations.list({ n: 20 });
  log(`\nconversations (${convs.length} shown):`);
  for (const c of convs)
    log(`  ${c.handle}  ${c.kind}  msgs=${c.msgCount}  ${c.topic ?? c.participantNames ?? ''}`);
  const people = store.people.find({ n: 10 });
  log(`\npeople (total ${people.total}):`);
  for (const p of people.rows)
    log(`  ${p.handle}  ${p.name}${p.isBot ? ' [bot]' : ''}  msgs=${p.msgCount}`);
  const search = store.messages.search({ query: 'the', limit: 5 });
  log(`\nsearch "the": ${search.ok ? `${search.rows.length} hits (order ${search.order})` : search.reason.reason}`);
  if (search.ok) for (const h of search.rows) log(`  [${h.senderName}] ${h.content.slice(0, 80)}`);
  const topics = store.topics.compute({ window: '30d', n: 8 });
  log(`\ntop topics (30d): ${topics.ok ? topics.rows.map((t: any) => t.phrase ?? JSON.stringify(t)).join(', ') : topics.reason.reason}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function selfTest() {
  clear();
  log('› initializing sqlite-wasm (from inlined bytes)…');
  await paint();
  const driver = await getDriver();
  const store = openStoreFromSource(new MemorySource(new Map()), { driver });
  log('✓ wasm driver + openStoreFromSource OK');
  log('  meta:', store.meta);
  store.close();
}

async function build(files: FileList) {
  clear();
  log(`› reading ${files.length} files…`);
  await paint();
  const map = new Map<string, Uint8Array>();
  for (const f of Array.from(files)) map.set(f.name, new Uint8Array(await f.arrayBuffer()));
  const driver = await getDriver();
  log('⏳ building store… (no Worker here — the tab will be unresponsive for a few seconds)');
  await paint(); // paint the ⏳ message BEFORE the synchronous build blocks the thread
  const phases: string[] = [];
  const t = performance.now();
  const store = openStoreFromSource(new MemorySource(map), {
    driver,
    onPhase: (phase: BuildPhase, ms) => phases.push(`  ✓ ${phase} ${Math.round(ms)}ms`),
  });
  const total = Math.round(performance.now() - t);
  for (const line of phases) log(line); // timings collected during the (blocking) build, shown after
  log(`✓ built store in ${total}ms\n`);
  render(store);
  store.close();
}

document.getElementById('selftest')!.addEventListener('click', () => {
  selfTest().catch((e) => log('✗ self-test failed:', (e as Error).message));
});
const input = document.getElementById('pick') as HTMLInputElement;
document.getElementById('pickBtn')!.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  if (input.files && input.files.length) build(input.files).catch((e) => log('✗', (e as Error).message));
});
log('ready. Run the self-test first, then pick your …indexeddb.leveldb folder.');
