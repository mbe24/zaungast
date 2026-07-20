// Platform loader for the native addon. Resolves the prebuilt `.node` for the current
// platform/arch/libc and re-exports its symbols (napi-rs maps Rust snake_case → JS camelCase, so
// `native_ingest` → `nativeIngest`, `conformance_version` → `conformanceVersion`).
//
// CommonJS on purpose (`.cjs`): the package is `type: module`, but the ESM shim (src/native.ts)
// requires this loader via createRequire — a native addon is a CJS artifact. This hand-written loader
// is the committed one; the build routes napi-rs's own generated loader to a scratch file so it never
// clobbers this. It finds a colocated `.node` (built locally or shipped) and throws a clear, actionable
// error otherwise — createNativeEngine() catches that and reports the engine unavailable, so the
// consumer falls back to libzaungast's built-in JS engine.
'use strict';

const { existsSync } = require('node:fs');
const { join } = require('node:path');

// Candidate binary names, most-specific first. Mirrors napi-rs's triple naming.
function candidates() {
  const { platform, arch } = process;
  const list = [];
  if (platform === 'win32') {
    list.push(`libzaungast-native.win32-${arch}-msvc.node`);
  } else if (platform === 'darwin') {
    list.push(`libzaungast-native.darwin-${arch}.node`);
  } else if (platform === 'linux') {
    // glibc vs musl: report.header.glibcVersionRuntime is absent on musl builds of Node.
    let isMusl = false;
    try {
      const r = process.report && process.report.getReport();
      isMusl = !!(r && r.header && !r.header.glibcVersionRuntime);
    } catch {
      isMusl = false;
    }
    list.push(`libzaungast-native.linux-${arch}-${isMusl ? 'musl' : 'gnu'}.node`);
  }
  return list;
}

let addon = null;
let loadError = null;
for (const name of candidates()) {
  const p = join(__dirname, name);
  if (existsSync(p)) {
    try {
      addon = require(p);
      break;
    } catch (e) {
      loadError = e;
    }
  }
}

if (!addon) {
  const tried = candidates().join(', ') || `${process.platform}-${process.arch}`;
  const detail = loadError ? ` (last error: ${loadError.message})` : '';
  throw new Error(
    `libzaungast-native: no prebuilt binary found for ${process.platform}-${process.arch}. ` +
      `Tried: ${tried}. Build it with \`npm run build\` in packages/libzaungast-native, ` +
      `or install a release that ships your platform's .node.${detail}`,
  );
}

module.exports.nativeIngest = addon.nativeIngest;
module.exports.nativeRefresh = addon.nativeRefresh;
module.exports.conformanceVersion = addon.conformanceVersion;
