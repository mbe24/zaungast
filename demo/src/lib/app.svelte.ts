// Shared app state: the Comlink data worker + the built WrappedData, so every page (overview, race, …)
// queries the same build without re-picking. build() is called from the home page's folder picker.
import * as Comlink from 'comlink';
import { createTeams, type Progress } from './teams';
import type { WrappedData } from './wrapped';

type Phase = 'idle' | 'building' | 'ready' | 'error';

export const app = $state<{
  phase: Phase;
  progress: string;
  error: string;
  data: WrappedData | null;
}>({
  phase: 'idle',
  progress: '',
  error: '',
  data: null,
});

let teams: ReturnType<typeof createTeams> | null = null;

// Prewarm the data worker (wasm SQLite init + parse-pool spawn) WHILE the user is still at the folder
// picker, so build() doesn't pay that latency after the pick. Fire-and-forget; idempotent worker-side.
export function prewarm(): void {
  teams ??= createTeams();
  teams.prewarm().catch(() => {});
}

export async function build(files: File[]): Promise<void> {
  if (!files.length) return;
  teams ??= createTeams();
  const t0 = performance.now();
  app.phase = 'building';
  app.error = '';
  app.data = null;
  try {
    await teams.build(
      files,
      Comlink.proxy((p: Progress) => {
        if (p.type === 'reading') app.progress = `Reading ${p.total} files…`;
        else if (p.type === 'decoding') app.progress = `Decoding ${p.name} (${p.i} of ${p.n})`;
        else app.progress = `Building store — ${p.phase}…`;
      }),
    );
    app.data = await teams.wrapped();
    app.phase = 'ready';
    console.log('[wrapped] pick→ready', Math.round(performance.now() - t0), 'ms');
  } catch (e) {
    app.error = (e as Error).message;
    app.phase = 'error';
  }
}
