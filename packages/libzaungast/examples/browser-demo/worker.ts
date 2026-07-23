// POC Web Worker: does all the heavy lifting off the main thread — read the picked files, init the
// @sqlite.org/sqlite-wasm driver, build the store (openStoreFromSource), and run a few facade queries —
// posting progress messages as it goes so the UI stays responsive. Built to poc/dist/worker.js. Served
// over http (Workers, module loading, and the wasm fetch all require http, not file://).
import { openStoreFromSource, MemorySource, type SnapshotSource } from 'libzaungast/web';
import { createSqliteWasmDriver } from '../sqlite-wasm-driver.ts';

type In = { kind: 'selftest' } | { kind: 'build'; files: File[] };
type Out =
  | { type: 'progress'; msg: string }
  | { type: 'decoding'; name: string; i: number; n: number }
  | { type: 'phase'; phase: string; ms: number }
  | { type: 'result'; data: unknown }
  | { type: 'error'; msg: string };

const post = (o: Out) => (self as unknown as Worker).postMessage(o);

// One WASM init per worker. locateFile resolves sqlite3.wasm next to worker.js (fetched + streamed).
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () =>
  (driverPromise ??= createSqliteWasmDriver({
    locateFile: (path: string) => new URL(path, import.meta.url).href,
  }));

self.onmessage = async (e: MessageEvent<In>) => {
  try {
    post({ type: 'progress', msg: 'initializing sqlite-wasm…' });
    const driver = await getDriver();

    if (e.data.kind === 'selftest') {
      const store = openStoreFromSource(new MemorySource(new Map()), { driver });
      post({ type: 'result', data: { selfTest: true, meta: store.meta } });
      store.close();
      return;
    }

    const { files } = e.data;
    post({ type: 'progress', msg: `reading ${files.length} files…` });
    const map = new Map<string, Uint8Array>();
    for (const f of files) map.set(f.name, new Uint8Array(await f.arrayBuffer()));

    // The decoder only reads .ldb/.log; a folder pick also includes leveldb metadata files (CURRENT,
    // MANIFEST-*, LOCK, LOG) that libzaungast never reads — report those so the file counts line up.
    const isData = (n: string) => n.endsWith('.ldb') || n.endsWith('.log');
    const dataFiles = [...map.keys()].filter(isData);
    const otherFiles = [...map.keys()].filter((n) => !isData(n));
    if (otherFiles.length)
      post({
        type: 'progress',
        msg: `${otherFiles.length} leveldb metadata ignored (${otherFiles.join(', ')})`,
      });
    post({ type: 'progress', msg: `${dataFiles.length} data files (.ldb/.log) to decode` });

    // Progress-reporting SnapshotSource (the A5 seam): the decoder calls read() once per .ldb/.log, so
    // reporting there gives live per-file progress with NO library change.
    let i = 0;
    const source: SnapshotSource = {
      names: () => [...map.keys()],
      read: (name) => {
        const f = map.get(name);
        if (!f) throw new Error(`no such file: ${name}`);
        post({ type: 'decoding', name, i: ++i, n: dataFiles.length });
        return f;
      },
    };

    const t = performance.now();
    const store = openStoreFromSource(source, {
      driver,
      onPhase: (phase, ms) => post({ type: 'phase', phase, ms: Math.round(ms) }),
    });
    const buildMs = Math.round(performance.now() - t);

    post({
      type: 'result',
      data: {
        buildMs,
        meta: store.meta,
        conversations: store.conversations.list({ n: 20 }),
        people: store.people.find({ n: 10 }),
        search: store.messages.search({ query: 'the', limit: 5 }),
        topics: store.topics.compute({ window: '30d', n: 8 }),
      },
    });
    store.close();
  } catch (err) {
    post({ type: 'error', msg: (err as Error).message });
  }
};
