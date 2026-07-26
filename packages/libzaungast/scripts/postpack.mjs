// postpack: restore the dev package.json that scripts/prepack.mjs backed up (undo the
// `development`-condition strip), so the in-repo dev workflow keeps resolving to ./src.
import { existsSync, renameSync } from 'node:fs';

const PKG = new URL('../package.json', import.meta.url);
const BAK = new URL('../package.json.prepack-bak', import.meta.url);

if (existsSync(BAK)) {
  renameSync(BAK, PKG);
  console.log('postpack: restored the dev package.json (development conditions back)');
}
