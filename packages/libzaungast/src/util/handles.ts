import { sha1Hex } from './hash.js';

// Short, stable, opaque handles derived from full Teams IDs (thread ids / MRIs).
// Stable across re-ingests and sessions (pure hash). Collision-extended by the store.
export function makeHandle(prefix: 'c' | 'p', fullId: string, len = 5): string {
  const h = sha1Hex(fullId).slice(0, len);
  return `${prefix}:${h}`;
}

// Stateful handle assignment: a stable short handle per full id, collision-extended in assignment order.
// Extracted verbatim from ChatStore so the SAME allocator drives the SQLite build AND any engine-agnostic
// derivation (see deriveTables) — the assignment order is the ONLY thing that determines the extended
// handles, so both callers must share one allocator + feed ids in the same order to get identical handles.
// The native Rust engine mirrors this exact algorithm (store/mod.rs `Handles`).
export class HandleAllocator {
  private readonly handleByFull = new Map<string, string>();
  private readonly usedHandles = new Set<string>();

  handleFor(prefix: 'c' | 'p', fullId: string): string {
    const cached = this.handleByFull.get(fullId);
    if (cached) return cached;
    // 6 hex chars (24 bits) → collision probability ~16× lower than 5, so the order-dependent
    // extension path below is essentially never hit. Residual (accepted, ~pre-release only): if
    // a fresh full rebuild adds an entity that collides at 6 chars with an existing one, the
    // assignment order can flip which one extends — a stale handle from before that rebuild
    // could then resolve differently. Handles are re-issued in every tool result, so the window
    // is one full rebuild between an agent reading and reusing a handle; negligible in practice.
    for (let len = 6; len <= 40; len++) {
      const h = makeHandle(prefix, fullId, len);
      if (!this.usedHandles.has(h)) {
        this.usedHandles.add(h);
        this.handleByFull.set(fullId, h);
        return h;
      }
    }
    const fb = `${prefix}:${fullId.slice(0, 12)}`;
    this.usedHandles.add(fb);
    this.handleByFull.set(fullId, fb);
    return fb;
  }
}
