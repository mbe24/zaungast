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
//
// Run:
//   node --conditions=development --experimental-sqlite --import tsx packages/libzaungast-native/test/smoke.ts
import { createNativeEngine } from 'libzaungast-native';

let pass = 0,
  fail = 0;
const ok = (name: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('\n=== native shim smoke (createNativeEngine) ===');
const engine = createNativeEngine();
if ('unavailable' in engine) {
  ok(
    'addon absent → clean { unavailable } reason (no throw)',
    typeof engine.unavailable === 'string' && engine.unavailable.length > 0,
    JSON.stringify(engine),
  );
} else {
  ok(
    'addon present → engine exposes full() + refresh()',
    typeof engine.full === 'function' && typeof engine.refresh === 'function',
    `keys=${Object.keys(engine).join(',')}`,
  );
  ok(
    'native engine offers the copy-reuse fast path (reuseRefresh present)',
    'reuseRefresh' in engine && typeof engine.reuseRefresh === 'function',
  );
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
