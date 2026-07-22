// Engine selection for the MCP server. libzaungast ships PURE (its built-in JS engine only); the
// optional native accelerator (libzaungast-native) is an OPTIONAL dependency. This is the single
// place that decides which IngestEngine to inject into openStore / openLiveStore, honoring the
// ZAUNGAST_ENGINE env var — libzaungast never chooses or falls back on its own (the client/engine split):
//   js (default)  — the built-in JS engine (inject nothing; the library uses createJsEngine()).
//   native        — REQUIRE the native engine; if it's absent or fails the conformance handshake,
//                   fail LOUDLY (the operator explicitly asked for native — don't silently downgrade).
//   auto          — use native when present + conformant, else fall back to JS with a note.
// libzaungast-native is an OPTIONAL co-install, not a hard dependency: it's deliberately NOT in this
// package's manifest (it's private/unpublished today, and a published zaungast must not force it), so
// it's loaded via dynamic import — resolved through the workspace in dev/CI, caught as non-fatal when
// absent. When it's published, declare it under optionalDependencies.
import type { LiveOptions } from 'libzaungast';

// The engine an openStore/openLiveStore call accepts — sourced from the client API (LiveOptions), so
// zaungast needs no engine-author SPI import; it only selects + injects a ready engine.
type Engine = NonNullable<LiveOptions['engine']>;

// Resolve the engine to inject plus a short human note (surfaced in the startup banner / test logs).
// `engine` undefined ⇒ the library's default JS engine.
export async function selectEngine(): Promise<{ engine?: Engine; note: string }> {
  const choice = (process.env.ZAUNGAST_ENGINE ?? 'js').toLowerCase();
  if (choice === 'js') return { note: 'js' };
  if (choice !== 'native' && choice !== 'auto')
    return { note: `js (unknown ZAUNGAST_ENGINE='${choice}', ignored)` };

  // Probe the optional accelerator. A missing package (not installed) throws on import → caught.
  let factory: typeof import('libzaungast-native').createNativeEngine | undefined;
  try {
    ({ createNativeEngine: factory } = await import('libzaungast-native'));
  } catch {
    factory = undefined;
  }
  if (!factory) {
    if (choice === 'native')
      throw new Error(
        "ZAUNGAST_ENGINE=native, but the optional 'libzaungast-native' package is not installed",
      );
    return { note: 'js (native accelerator not installed)' };
  }

  // The conformance handshake lives inside createNativeEngine(); it reports { unavailable } as DATA.
  const engine = factory();
  if ('unavailable' in engine) {
    if (choice === 'native')
      throw new Error(
        `ZAUNGAST_ENGINE=native, but the native engine is unavailable: ${engine.unavailable}`,
      );
    return { note: `js (native unavailable: ${engine.unavailable})` };
  }
  return { engine, note: 'native' };
}
