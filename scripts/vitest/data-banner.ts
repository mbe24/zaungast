// Vitest globalSetup for the data-gated projects (int/real). When no leveldb cache is available, the
// suite self-skips (green) — but a silent skip is this repo's failure mode, so print a visible reason.
// globalSetup runs in vitest's MAIN process (real stderr, not per-test-captured), so this banner shows
// in the DEFAULT reporter; a per-test console.warn would be swallowed. Individual tests still gate with
// `test.skipIf(!dir)`; this only explains WHY the run shows skips.
import { resolveLevelDbDir } from '../native-runner.mjs';

export default function dataBanner(): void {
  if (!resolveLevelDbDir(process.env.ZAUNGAST_TEST_DIR)) {
    console.warn(
      '\n[int/real] data suites SKIPPED — no leveldb dir (pass one, or set ZAUNGAST_TEST_DIR).\n',
    );
  }
}
