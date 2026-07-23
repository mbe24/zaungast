// POC main-thread script: wires the buttons, spawns the Web Worker, streams its progress into the
// output, and renders the result it posts back. All the heavy work (decode + wasm SQLite build) runs in
// the worker, so clicking a button never freezes the page. Built to poc/dist/main.js.
const out = document.getElementById('out') as HTMLPreElement;
// Output = committed lines + one optional transient "status" line (the current decode file), which
// subsequent status() calls replace in place. A permanent log() finalizes/clears the status line.
let committed = '';
let live: string | null = null;
const paint = () => {
  out.textContent = committed + (live !== null ? live + '\n' : '');
};
const log = (...xs: unknown[]) => {
  committed += xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ') + '\n';
  live = null;
  paint();
};
const status = (msg: string) => {
  live = msg;
  paint();
};
const clear = () => {
  committed = '';
  live = null;
  paint();
};

// A module worker (needs http, not file://). Vite/esbuild emit worker.js next to main.js.
const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

/* eslint-disable @typescript-eslint/no-explicit-any */
// Render meta's three epoch-ms timestamps (asOf, earliestTs, lastFullAt) as local date/time — POC
// display only; the library returns raw epoch ms. 0 (e.g. earliestTs with no messages) shows "(none)".
function fmtMeta(m: any) {
  const t = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString() : '(none)');
  return { ...m, asOf: t(m.asOf), earliestTs: t(m.earliestTs), lastFullAt: t(m.lastFullAt) };
}
function renderResult(d: any) {
  if (d.selfTest) {
    log('✓ wasm driver + openStoreFromSource OK');
    log('  meta:', fmtMeta(d.meta));
    log('  (empty source → schemaMatched:', d.meta.schemaMatched, ')');
    return;
  }
  log(`✓ built store in ${d.buildMs}ms\n`);
  log('meta:', fmtMeta(d.meta));
  log(`\nconversations (${d.conversations.length} shown):`);
  for (const c of d.conversations)
    log(`  ${c.handle}  ${c.kind}  msgs=${c.msgCount}  ${c.topic ?? c.participantNames ?? ''}`);
  log(`\npeople (total ${d.people.total}):`);
  for (const p of d.people.rows)
    log(`  ${p.handle}  ${p.name}${p.isBot ? ' [bot]' : ''}  msgs=${p.msgCount}`);
  log(`\nsearch "the": ${d.search.ok ? `${d.search.rows.length} hits (order ${d.search.order})` : d.search.reason.reason}`);
  if (d.search.ok) for (const h of d.search.rows) log(`  [${h.senderName}] ${h.content.slice(0, 80)}`);
  log(`\ntop topics (30d): ${d.topics.ok ? d.topics.rows.map((t: any) => t.phrase ?? JSON.stringify(t)).join(', ') : d.topics.reason.reason}`);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'progress') log('› ' + m.msg);
  else if (m.type === 'decoding') status(`  decoding ${m.name} (${m.i} of ${m.n})`); // single line, updates in place
  else if (m.type === 'phase') log(`  ✓ ${m.phase} ${m.ms}ms`);
  else if (m.type === 'error') log('✗ ' + m.msg);
  else if (m.type === 'result') renderResult(m.data);
};

document.getElementById('selftest')!.addEventListener('click', () => {
  clear();
  worker.postMessage({ kind: 'selftest' });
});
const input = document.getElementById('pick') as HTMLInputElement;
document.getElementById('pickBtn')!.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  if (!input.files || !input.files.length) return;
  clear();
  worker.postMessage({ kind: 'build', files: Array.from(input.files) });
});
log('ready. Run the self-test first, then pick your Teams cache folder.');
