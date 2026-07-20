// Ingest-engine SELECTION POLICY: which backend runs, and how it's chosen. Kept separate from
// native.ts (which is native MECHANISM only) — two of the three engine values ('js', 'auto') have
// nothing to do with native, so the vocabulary + default belong here, not in the native module.

export type Engine = 'auto' | 'js' | 'native';

// Resolve the effective engine: explicit env override (ZAUNGAST_ENGINE) wins, then the option, else
// the default 'js'. An unrecognized env value is ignored (falls through to the option/default).
//
// Default is 'js' (NOT 'auto'): the native engine is not picked up implicitly, even when a prebuilt
// addon is present, until it's proven across platforms. Opt in per-call with engine:'auto'|'native'
// or globally with ZAUNGAST_ENGINE. Revisit the default once native has real multi-platform mileage.
export function resolveEngine(opt?: Engine): Engine {
  const env = (process.env.ZAUNGAST_ENGINE || '').toLowerCase();
  if (env === 'js' || env === 'native' || env === 'auto') return env;
  return opt ?? 'js';
}
