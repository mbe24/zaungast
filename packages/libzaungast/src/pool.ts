/// <reference lib="webworker" />
// Browser Web Worker pool implementing the structural `Pool` (./parallel.ts) that the parallel build
// drives: dispatch messages to N workers, one job per worker at a time, results matched by which worker
// replied (no message ids). A worker that errors (incl. an ASYNC module-load failure — the common
// nested-worker-unsupported path, which does NOT throw synchronously from `new Worker`) is terminated and
// removed, its in-flight job rejected; if the pool empties, every queued job is rejected — so a caller's
// `Promise.all` always settles and can fall back to serial. `createPool` rethrows if worker creation
// throws synchronously (after terminating any partial set).
//
// This is the ONE library module that references the browser `Worker`, hence the `webworker` lib
// reference (the package is otherwise Node-typed). The workers it spawns must speak the PoolRequest
// protocol — a two-line entry over `handlePoolMessage` (see ./pool-worker.ts).
import type { Pool } from './parallel.js';
import type { PoolRequest } from './pool-worker.js';

type Job = {
  msg: PoolRequest;
  transfer: ArrayBuffer[];
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
    run<T>(msg: PoolRequest, transfer: ArrayBuffer[] = []): Promise<T> {
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
