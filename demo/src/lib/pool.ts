// Minimal Web Worker pool: dispatch messages to N workers, one job per worker at a time, results matched
// by which worker replied (no message ids needed). Used to fan `.ldb` parse + SSV extract out across
// cores. createPool throws synchronously if the environment can't spawn the worker (e.g. nested workers
// unsupported) — the caller catches and falls back to the serial path.
export interface Pool {
  readonly size: number;
  run<T>(msg: Record<string, unknown>, transfer?: Transferable[]): Promise<T>;
  destroy(): void;
}

export function createPool(factory: () => Worker, size: number): Pool {
  const idle: Worker[] = [];
  const queue: {
    msg: Record<string, unknown>;
    transfer: Transferable[];
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  }[] = [];
  const busy = new Map<Worker, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const pump = () => {
    while (idle.length && queue.length) {
      const w = idle.shift()!;
      const job = queue.shift()!;
      busy.set(w, { resolve: job.resolve, reject: job.reject });
      w.postMessage(job.msg, job.transfer);
    }
  };

  const workers = Array.from({ length: size }, () => {
    const w = factory();
    w.onmessage = (e: MessageEvent) => {
      const p = busy.get(w);
      busy.delete(w);
      idle.push(w);
      p?.resolve(e.data);
      pump();
    };
    w.onerror = (e: ErrorEvent) => {
      const p = busy.get(w);
      busy.delete(w);
      idle.push(w);
      p?.reject(e.message || e);
      pump();
    };
    idle.push(w);
    return w;
  });

  return {
    size,
    run<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({ msg, transfer, resolve: resolve as (v: unknown) => void, reject });
        pump();
      });
    },
    destroy() {
      workers.forEach((w) => w.terminate());
    },
  };
}
