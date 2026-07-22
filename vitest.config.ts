import { defineConfig } from 'vitest/config';

// One framework, five role suites — mirrors the filename-role convention (see scripts/check-test-naming.mjs,
// which guarantees every test file carries one of these suffixes so none is silently unmatched).
//   unit/fixture/golden — CI-safe (synthetic/pure); run on every push.
//   int/real            — data-gated: self-skip (green) when no leveldb cache is present, printing a
//                         reason via the globalSetup banner (visible in the default reporter).
const role = (name: string, extra: Record<string, unknown> = {}) => ({
  extends: true,
  test: { name, include: [`packages/*/test/**/*.${name}.ts`], ...extra },
});

export default defineConfig({
  // Replaces the old `--conditions=development` node flag: resolve workspace packages to their TS
  // source (the `development` export condition), not their built dist.
  resolve: { conditions: ['development'] },
  test: {
    // node:sqlite (the ChatStore) needs --experimental-sqlite on the engines floor (22.5–22.12);
    // harmless no-op on newer 22.x. `test.execArgv` is the vitest-4 key that actually forwards flags to
    // the fork workers (the v3 `poolOptions.forks.execArgv` nesting is silently ignored in v4).
    pool: 'forks',
    execArgv: ['--experimental-sqlite'],
    projects: [
      role('unit'),
      role('fixture'),
      role('golden'),
      // Integration/real suites do real filesystem + SQLite work, and some assert on GLOBAL state
      // (e.g. "no leaked temp dirs in os.tmpdir()"). Run their files serially so concurrent workers'
      // fixtures can't pollute those observations — matching the old sequential integration harness.
      role('int', {
        globalSetup: ['./scripts/vitest/data-banner.ts'],
        testTimeout: 30_000,
        fileParallelism: false,
      }),
      role('real', {
        globalSetup: ['./scripts/vitest/data-banner.ts'],
        testTimeout: 30_000,
        fileParallelism: false,
      }),
    ],
  },
});
