// G3 — real-data digest golden. High-coverage regression net over the REAL local Teams corpus,
// for the steps whose correctness only manifests at scale (view aliasing, the real fingerprint
// hash + wrapper-less-sample quirk, scratch aliasing — see plan/roadmap.md Phase-0 scale rule).
//
// PII-SAFE: the committed golden contains ONLY the fingerprint hash, per-entity row COUNTS, and a
// sha256 of the canonicalized rows — never any message/person content. Hashes+counts are not PII.
//
// SKIP-IF-ABSENT: the real snapshot is local-only (gitignored `data/`), so on a machine without it
// this test prints SKIP and exits 0. It gates locally, before merging A2/A5/A7.
//
// Run:  node --experimental-sqlite --import tsx test/golden/real-digest.ts   [<leveldb-dir>]
//       UPDATE_GOLDEN=1 node --experimental-sqlite --import tsx test/golden/real-digest.ts
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSnapshot,
  fingerprint,
  selectMapping,
  loadMapping,
} from '../../src/format/index.js';
import { extractEntity } from '../../src/format/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(here, 'real-digest.golden.json');
const VERSIONS = path.resolve(here, '../../src/schema/versions');

// Locate a real leveldb store: env, argv, else auto-find a `*.leveldb` dir under ./data with CURRENT.
function autofind(root: string): string | undefined {
  if (!fs.existsSync(root)) return undefined;
  const stack = [root];
  let depth = 0;
  const found: string[] = [];
  while (stack.length && depth++ < 5000) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    if (/\.leveldb$/i.test(d) && ents.some((e) => e.isFile() && e.name === 'CURRENT')) found.push(d);
    for (const e of ents) if (e.isDirectory()) stack.push(path.join(d, e.name));
  }
  found.sort(); // deterministic pick if several snapshots are present
  return found[0];
}

const DIR = process.env.ZAUNGAST_REAL_DIR ?? process.argv[2] ?? autofind(path.resolve('data'));

if (!DIR || !fs.existsSync(path.join(DIR, 'CURRENT'))) {
  console.log('  SKIP real-digest: no local real leveldb store found (set ZAUNGAST_REAL_DIR).');
  process.exit(0);
}

let pass = 0,
  fail = 0;
const ok = (n: string, c: boolean, d = '') => {
  if (c) {
    pass++;
    console.log(`  PASS ${n}`);
  } else {
    fail++;
    console.log(`  FAIL ${n} ${d}`);
  }
};

// Recursively key-sorted JSON — canonical regardless of property insertion order.
function canonical(v: unknown): string {
  return JSON.stringify(v, function repl(_k, val) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(val as Record<string, unknown>).sort()) o[k] = (val as any)[k];
      return o;
    }
    return val;
  });
}

function digestOf(dir: string) {
  const mappings = fs
    .readdirSync(VERSIONS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadMapping(path.join(VERSIONS, f)));
  const snap = loadSnapshot(dir);
  const fp = fingerprint(snap);
  const { mapping } = selectMapping(mappings, fp);
  if (!mapping) throw new Error('selectMapping returned no mapping for the real store fingerprint');
  const entities: Record<string, { count: number; sha256: string }> = {};
  for (const name of Object.keys(mapping.entities)) {
    const rows = extractEntity(snap, mapping, name).records;
    // sort rows deterministically (by __key, tie-break on canonical JSON) before hashing
    const sorted = [...rows].sort((a, b) => {
      const ka = String((a as any).__key ?? ''),
        kb = String((b as any).__key ?? '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      const ja = canonical(a),
        jb = canonical(b);
      return ja < jb ? -1 : ja > jb ? 1 : 0;
    });
    const sha256 = crypto.createHash('sha256').update(canonical(sorted)).digest('hex');
    entities[name] = { count: rows.length, sha256 };
  }
  return { fingerprint: fp.hash, entities };
}

const digest = digestOf(DIR);

if (process.env.UPDATE_GOLDEN) {
  fs.writeFileSync(GOLDEN, JSON.stringify(digest, null, 2) + '\n');
  console.log(`  wrote golden → ${path.relative(process.cwd(), GOLDEN)}`);
  console.log(`  fingerprint ${digest.fingerprint}`);
  for (const [n, e] of Object.entries(digest.entities))
    console.log(`    ${n}: ${e.count} rows · ${e.sha256.slice(0, 12)}…`);
  ok('golden written', true);
} else {
  const have = fs.existsSync(GOLDEN)
    ? (JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as typeof digest)
    : null;
  if (!have) {
    ok('golden exists', false, 'run once with UPDATE_GOLDEN=1 on the machine holding the real data');
  } else {
    ok('fingerprint matches', have.fingerprint === digest.fingerprint, `${have.fingerprint} vs ${digest.fingerprint}`);
    const names = new Set([...Object.keys(have.entities), ...Object.keys(digest.entities)]);
    for (const n of [...names].sort()) {
      const h = have.entities[n],
        g = digest.entities[n];
      ok(
        `entity ${n} digest matches`,
        !!h && !!g && h.count === g.count && h.sha256 === g.sha256,
        h && g ? `count ${h.count}->${g.count}, sha ${h.sha256.slice(0, 8)}->${g.sha256.slice(0, 8)}` : 'entity missing on one side',
      );
    }
  }
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
