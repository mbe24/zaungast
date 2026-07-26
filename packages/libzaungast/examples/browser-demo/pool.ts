// Minimal Web Worker pool: dispatch messages to N workers, one job per worker at a time, results matched
// by which worker replied (no message ids needed). Used to fan `.ldb` parse + SSV extract out across
// cores. A worker that errors (incl. an ASYNC module-load failure — the common nested-worker-unsupported
// path, which does NOT throw synchronously from `new Worker`) is terminated and removed, its in-flight job
// rejected, and if the pool empties every queued job is rejected — so a caller's `Promise.all` always
// settles (never hangs) and can fall back to the serial path. `createPool` rethrows if worker creation
// itself throws synchronously (after terminating any partial set).
export interface Pool {
  readonly size: number;
  run<T>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
  destroy(): void;
}

type Job = {
  msg: Record<string, unknown>;
  transfer: Transferable[];
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
};

export function createPool(factory: () => Worker, size: number): Pool {
  const workers: Worker[] = [];
  const idle: Worker[] = [];
  const queue: Job[] = [];
  const busy = new Map<Worker, Job>();

  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.shift()!;
      const job = queue.shift()!;
      busy.set(w, job);
      try {
        w.postMessage(job.msg, job.transfer);
      } catch (e) {
        // e.g. DataCloneError / bad transferable — never leave the worker stuck in `busy`.
        busy.delete(w);
        idle.push(w);
        job.reject(e);
      }
    }
  };

  const remove = (w: Worker) => {
    const wi = workers.indexOf(w);
    if (wi >= 0) workers.splice(wi, 1);
    const ii = idle.indexOf(w);
    if (ii >= 0) idle.splice(ii, 1);
    try {
      w.terminate();
    } catch {
      /* already gone */
    }
  };

  try {
    for (let k = 0; k < size; k++) {
      const w = factory();
      w.onmessage = (e: MessageEvent) => {
        const job = busy.get(w);
        if (!job) return; // spurious/late message with no in-flight job — ignore, don't touch idle
        busy.delete(w);
        idle.push(w);
        job.resolve(e.data);
        pump();
      };
      w.onerror = (e: ErrorEvent) => {
        const job = busy.get(w);
        busy.delete(w);
        remove(w); // a broken worker (crash or script-load failure) must NEVER be reused
        job?.reject(new Error(e?.message || 'worker error'));
        if (workers.length === 0)
          queue.splice(0).forEach((j) => j.reject(new Error('worker pool died')));
        pump();
      };
      workers.push(w);
      idle.push(w);
    }
  } catch (e) {
    workers.forEach((w) => {
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
    });
    throw e;
  }

  return {
    get size() {
      return workers.length;
    },
    run<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ msg, transfer, resolve: resolve as (v: unknown) => void, reject });
        pump();
      });
    },
    destroy() {
      workers.splice(0).forEach((w) => {
        try {
          w.terminate();
        } catch {
          /* ignore */
        }
      });
    },
  };
}
