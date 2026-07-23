import { sha1Hex } from './hash.js';

// Short, stable, opaque handles derived from full Teams IDs (thread ids / MRIs).
// Stable across re-ingests and sessions (pure hash). Collision-extended by the store.
export function makeHandle(prefix: 'c' | 'p', fullId: string, len = 5): string {
  const h = sha1Hex(fullId).slice(0, len);
  return `${prefix}:${h}`;
}
