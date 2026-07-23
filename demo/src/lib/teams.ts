// Main-thread handle to the data worker. Comlink turns the worker into an async proxy so the UI can
// `await teams.build(files, …)` / `await teams.wrapped()` as if local. Pass progress callbacks wrapped
// in Comlink.proxy(...) so the worker can call back across the thread boundary.
import * as Comlink from 'comlink';
import type { TeamsApi, Progress } from './teams.worker';

export type { Progress };

export function createTeams(): Comlink.Remote<TeamsApi> {
	const worker = new Worker(new URL('./teams.worker.ts', import.meta.url), { type: 'module' });
	return Comlink.wrap<TeamsApi>(worker);
}
