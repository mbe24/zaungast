// Copy the non-TS build assets tsc doesn't emit: the bundled schema-mapping JSONs and the single-
// source schema.sql. Run after `tsc` by the package `build` script. ESM (the package is ESM-only) —
// replaces the old inline `node -e "require('fs')…"` CJS shim (modernization #5).
import { cpSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url)); // packages/libzaungast/
cpSync(`${pkg}src/schema/versions`, `${pkg}dist/schema/versions`, { recursive: true });
copyFileSync(`${pkg}src/schema.sql`, `${pkg}dist/schema.sql`);
