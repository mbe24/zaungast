// Data-layer Web Worker (exposed via Comlink). Owns libzaungast/web + the wasm SQLite driver so all the
// heavy work — decode + build + query — runs off the main thread. The store stays resident so multiple
// visualizations (Wrapped now; contact graph etc. later) query the same build. Progress is reported
// through a Comlink-proxied callback the main thread passes in.
import * as Comlink from 'comlink';
import {
	openStoreFromSource,
	openStoreFromSnapshot,
	loadSnapshotFrom,
	fingerprint,
	type SnapshotSource,
	type Snapshot,
	type TableReadResult,
	type TeamsStore,
	type StoreMeta,
	type BuildPhase,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from './sqlite-wasm-driver';
import { createPool, type Pool } from './pool';
// Vite resolves the wasm to a served URL; the driver's locateFile hands it to the sqlite-wasm glue.
import sqlite3Url from '@sqlite.org/sqlite-wasm/sqlite3.wasm?url';
import { computeWrapped, type WrappedData } from './wrapped';

export type Progress =
	| { type: 'reading'; total: number }
	| { type: 'decoding'; name: string; i: number; n: number }
	| { type: 'phase'; phase: BuildPhase; ms: number };

let store: TeamsStore | null = null;
let driverPromise: ReturnType<typeof createSqliteWasmDriver> | null = null;
const getDriver = () => (driverPromise ??= createSqliteWasmDriver({ locateFile: () => sqlite3Url }));

const isData = (n: string) => n.endsWith('.ldb') || n.endsWith('.log');

const api = {
	// Build the store from a picked leveldb folder. Reports progress via the (optional) proxied callback.
	async build(files: File[], onProgress?: (p: Progress) => void): Promise<StoreMeta> {
		const driver = await getDriver();
		onProgress?.({ type: 'reading', total: files.length });
		// Read every file's bytes CONCURRENTLY (File.arrayBuffer() is async I/O). The serial
		// `await` loop this replaces read one file at a time; Promise.all overlaps the disk reads.
		const tRead = performance.now();
		const buffers = await Promise.all(files.map((f) => f.arrayBuffer()));
		const map = new Map<string, Uint8Array>();
		files.forEach((f, idx) => map.set(f.name, new Uint8Array(buffers[idx])));
		const readMs = performance.now() - tRead;

		const dataFiles = [...map.keys()].filter(isData);
		let i = 0;
		const source: SnapshotSource = {
			names: () => [...map.keys()],
			read: (name) => {
				const bytes = map.get(name);
				if (!bytes) throw new Error(`no such file: ${name}`);
				if (isData(name)) onProgress?.({ type: 'decoding', name, i: ++i, n: dataFiles.length });
				return bytes;
			},
		};

		store?.close();
		const phaseMs: Record<string, number> = {};
		const onPhase = (phase: BuildPhase, ms: number) => {
			phaseMs[phase] = Math.round(ms);
			onProgress?.({ type: 'phase', phase, ms: Math.round(ms) });
		};

		// C3: parse the `.ldb` files across a Web Worker pool (the biggest cold-read phase), then fold the
		// Snapshot on this coordinator (byte-identical order → same fingerprint) and build the store from
		// it. Falls back to the serial path if a pool can't be created (e.g. nested workers unsupported) or
		// any parse fails — the coordinator keeps the raw bytes, so the fallback is always safe.
		const ldbNames = [...map.keys()].filter((n) => n.endsWith('.ldb'));
		let pool: Pool | null = null;
		try {
			const cores = self.navigator?.hardwareConcurrency || 4;
			const size = Math.min(ldbNames.length, Math.max(1, cores - 1));
			if (ldbNames.length > 1 && size > 1)
				pool = createPool(
					() => new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' }),
					size,
				);
		} catch {
			pool = null;
		}

		const tBuild = performance.now();
		let parseMs = 0;
		let usedPool = false;
		let snap: Snapshot | null = null;
		if (pool) {
			try {
				const tParse = performance.now();
				const parsed = new Map<string, TableReadResult>();
				await Promise.all(
					ldbNames.map(async (n) => {
						const res = await pool!.run<TableReadResult>({ bytes: map.get(n)! });
						parsed.set(n, res);
						onProgress?.({ type: 'decoding', name: n, i: ++i, n: dataFiles.length });
					}),
				);
				parseMs = performance.now() - tParse;
				snap = loadSnapshotFrom(source, { parsedTables: parsed });
				usedPool = true;
			} catch (e) {
				console.warn('[zaungast] parse pool failed → serial fallback', e);
				snap = null;
				usedPool = false;
			} finally {
				pool.destroy();
			}
		}

		if (usedPool && snap) {
			// Dev-only: prove the parallel-folded Snapshot equals a serial one (on the user's real data).
			if (import.meta.env.DEV) {
				const ok = fingerprint(snap).hash === fingerprint(loadSnapshotFrom(source)).hash;
				console.log(
					ok
						? '[zaungast verify] parallel snapshot == serial ✓'
						: '[zaungast verify] ✗ FINGERPRINT MISMATCH',
				);
			}
			store = await openStoreFromSnapshot(snap, { driver, deferFts: true, onPhase });
		} else {
			store = openStoreFromSource(source, { driver, deferFts: true, onPhase });
		}
		const buildMs = performance.now() - tBuild;

		console.log('[zaungast cold-read ms]', {
			fileRead: Math.round(readMs),
			parsePool: usedPool ? Math.round(parseMs) : 'serial',
			...phaseMs, // extract · apply · recompute · (decode only on the serial path; fts deferred)
			buildTotal: Math.round(buildMs),
			grandTotal: Math.round(readMs + buildMs),
			files: files.length,
			ldb: ldbNames.length,
			pool: pool ? pool.size : 0,
			cores: self.navigator?.hardwareConcurrency ?? 0,
		});
		return store.meta;
	},

	async wrapped(): Promise<WrappedData> {
		if (!store) throw new Error('no store built yet');
		return computeWrapped(store);
	},
};

export type TeamsApi = typeof api;
Comlink.expose(api);
