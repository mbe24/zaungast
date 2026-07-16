// Dependency-direction guard (B0): libzaungast must NEVER import from zaungast (the MCP). The MCP
// depends on the library, never the reverse. Fails loudly if any lib source references a zaungast
// module by package name or by a relative path escaping into packages/zaungast.
import fs from 'node:fs';
import path from 'node:path';

const libSrc = path.resolve('packages/libzaungast/src');
const offenders = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) {
      const text = fs.readFileSync(p, 'utf8');
      for (const m of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1];
        if (/^zaungast(\/|$)/.test(spec) || /zaungast[\\/]/.test(spec.replace(/^\.\.[\\/]/, ''))) {
          offenders.push(`${path.relative('.', p)} -> ${spec}`);
        }
      }
    }
  }
}
walk(libSrc);

if (offenders.length) {
  console.error('FAIL dependency-direction: libzaungast must not import zaungast (MCP):');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('PASS dependency-direction: libzaungast has no imports from zaungast (MCP).');
