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
  committed +=
    xs.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ') + '\n';
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
  // parse-pool time is shown live as the `✓ decode …ms (using N workers)` phase line above.
  const warmLine =
    d.driverWait != null
      ? ` · driverWait ${d.driverWait}ms${d.prewarmed ? ' (pool prewarmed)' : ''}`
      : '';
  // engine + per-example query times stream live as `✓ <phase> Nms` lines above (both engines); the
  // built-store line just notes which engine answered.
  const engineLine = d.engine ? ` · engine ${d.engine}` : '';
  log(`✓ built store in ${d.buildMs}ms  [${d.mode}]${engineLine}${warmLine}\n`);
  log('meta:', fmtMeta(d.meta));
  log(`\nconversations (${d.conversations.length} shown):`);
  for (const c of d.conversations)
    log(`  ${c.handle}  ${c.kind}  msgs=${c.msgCount}  ${c.topic ?? c.participantNames ?? ''}`);
  log(`\npeople (total ${d.people.total}):`);
  for (const p of d.people.rows)
    log(`  ${p.handle}  ${p.name}${p.isBot ? ' [bot]' : ''}  msgs=${p.msgCount}`);
  log(
    `\nsearch "the": ${d.search.ok ? `${d.search.rows.length} hits (order ${d.search.order})` : d.search.reason.reason}`,
  );
  if (d.search.ok)
    for (const h of d.search.rows) log(`  [${h.senderName}] ${h.content.slice(0, 80)}`);
  log(
    `\ntop topics (30d): ${d.topics.ok ? d.topics.rows.map((t: any) => t.phrase ?? JSON.stringify(t)).join(', ') : d.topics.reason.reason}`,
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

let pickT0 = 0; // set when the folder is picked; measures the full pick→result perceived latency
worker.onmessage = (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'progress') log('› ' + m.msg);
  else if (m.type === 'decoding')
    status(`  decoding ${m.name} (${m.i} of ${m.n})`); // single line, updates in place
  else if (m.type === 'phase')
    log(`  ✓ ${m.phase} ${m.ms == null ? '—' : m.ms + 'ms'}${m.note ? ' ' + m.note : ''}`);
  else if (m.type === 'error') log('✗ ' + m.msg);
  else if (m.type === 'result') {
    if (pickT0 && !m.data.selfTest)
      log(`⏱ pick→result ${Math.round(performance.now() - pickT0)}ms`);
    renderResult(m.data);
  }
};

document.getElementById('selftest')!.addEventListener('click', () => {
  clear();
  worker.postMessage({ kind: 'selftest' });
});
const input = document.getElementById('pick') as HTMLInputElement;
const parallelToggle = document.getElementById('parallel') as HTMLInputElement;
// Query engine picker (iOS pull-down): SQLite (full, FTS5) vs DuckDB (analytics; search degrades to LIKE).
const engineSel = document.getElementById('engine') as HTMLSelectElement;

// Threads stepper: worker-pool size for parallel mode, 2 … min(10, cores), default 8. (10 not 8 so the
// degradation past the sweet spot is visible.) Disabled when parallel is off.
const stepper = document.getElementById('threads-stepper')!;
const threadVal = document.getElementById('thread-val')!;
const decBtn = document.getElementById('thread-dec') as HTMLButtonElement;
const incBtn = document.getElementById('thread-inc') as HTMLButtonElement;
const MIN_THREADS = 2;
const MAX_THREADS = Math.max(MIN_THREADS, Math.min(10, navigator.hardwareConcurrency || 4));
let threads = Math.min(8, MAX_THREADS);

// Prewarm on load / whenever parallel or the thread count changes, so the warm pool matches what the next
// build will spawn (worker.ts `warmTo` respawns if the size differs). Sends the current thread count.
const doPrewarm = () =>
  worker.postMessage({
    kind: 'prewarm',
    parallel: parallelToggle.checked,
    threads,
    engine: engineSel.value as 'sqlite' | 'duckdb',
  });
const renderThreads = () => {
  threadVal.textContent = String(threads);
  const on = parallelToggle.checked;
  stepper.classList.toggle('disabled', !on);
  decBtn.disabled = !on || threads <= MIN_THREADS;
  incBtn.disabled = !on || threads >= MAX_THREADS;
};
const stepThreads = (delta: number) => {
  const next = Math.min(MAX_THREADS, Math.max(MIN_THREADS, threads + delta));
  if (next === threads) return;
  threads = next;
  renderThreads();
  doPrewarm(); // re-warm the pool to the new size while the user is still choosing a folder
};
decBtn.addEventListener('click', () => stepThreads(-1));
incBtn.addEventListener('click', () => stepThreads(1));

document.getElementById('pickBtn')!.addEventListener('click', () => input.click());
input.addEventListener('change', () => {
  if (!input.files || !input.files.length) return;
  clear();
  pickT0 = performance.now();
  worker.postMessage({
    kind: 'build',
    files: Array.from(input.files),
    parallel: parallelToggle.checked,
    threads,
    engine: engineSel.value as 'sqlite' | 'duckdb',
  });
});

parallelToggle.addEventListener('change', () => {
  renderThreads(); // enable/disable the stepper to match
  doPrewarm();
});
// Re-warm when the engine changes so DuckDB's wasm is inited during selection, not at build time.
engineSel.addEventListener('change', doPrewarm);
renderThreads();
doPrewarm();
log('ready. Run the self-test first, then pick your Teams cache folder.');
