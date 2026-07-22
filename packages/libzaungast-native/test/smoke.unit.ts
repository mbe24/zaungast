// Cross-environment smoke for the native shim (data-free, CI). Exercises the full ESM import graph —
// including runtime resolution of 'libzaungast/engine-spi' and the CJS addon loader — and asserts
// createNativeEngine()'s two honest outcomes without ever throwing:
//   • a usable IngestEngine (full() + refresh() + the copy-reuse reuseRefresh()) when a conformant
//     addon is present (the native-build matrix / a local .node), or
//   • a clear { unavailable } reason when it isn't (dev hosts / unit CI with no prebuilt .node).
// This guards the shim's structure + its dependence on the engine-spi surface (a broken SPI export
// trips it at runtime even if types slipped), while the byte-differential harness proves the Rust
// output itself. The native ingest RESULT (full/refresh against a real cache) is validated separately
// on a host that can build + execute the .node.
import { test, expect } from 'vitest';
import { createNativeEngine } from 'libzaungast-native';

test('native shim smoke (createNativeEngine)', () => {
  const engine = createNativeEngine();
  if ('unavailable' in engine) {
    expect(
      typeof engine.unavailable === 'string' && engine.unavailable.length > 0,
      JSON.stringify(engine),
    ).toBe(true);
  } else {
    expect(
      typeof engine.full === 'function' && typeof engine.refresh === 'function',
      `keys=${Object.keys(engine).join(',')}`,
    ).toBe(true);
    expect(
      'reuseRefresh' in engine && typeof engine.reuseRefresh === 'function',
      'native engine offers the copy-reuse fast path (reuseRefresh present)',
    ).toBe(true);
  }
});
