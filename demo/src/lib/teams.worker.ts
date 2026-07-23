// Data-layer Web Worker (exposed via Comlink). Owns libzaungast/web + the wasm SQLite driver so all the
// heavy work — decode + build + query — runs off the main thread. The store stays resident so multiple
// visualizations (Wrapped now; contact graph etc. later) query the same build. Progress is reported
// through a Comlink-proxied callback the main thread passes in.
import * as Comlink from 'comlink';
import {
	openStoreFromSource,
	type SnapshotSource,
	type TeamsStore,
	type StoreMeta,
	type BuildPhase,
} from 'libzaungast/web';
import { createSqliteWasmDriver } from './sqlite-wasm-driver';
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
		const map = new Map<string, Uint8Array>();
		for (const f of files) map.set(f.name, new Uint8Array(await f.arrayBuffer()));

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
		store = openStoreFromSource(source, {
			driver,
			onPhase: (phase, ms) => onProgress?.({ type: 'phase', phase, ms: Math.round(ms) }),
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
