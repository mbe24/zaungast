import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type Ingested } from './ingest/ingest.js';
import { createJsEngine, type JsEngine } from './ingest/js-engine.js';
import { nativeRefresh } from './ingest/native.js';
import { discoverTeamsDbs } from './format/index.js';

// Self-heal backstop: force a full rebuild at least this often, so any incremental drift is
// bounded to minutes. (Correctness doesn't depend on it — incremental reconciles deletions —
// but it's a cheap safety net.)
const MAX_INCREMENTALS = 20;
const FULL_INTERVAL_MS = 30 * 60_000;

// ============================================================================
// SAFETY CONTRACT (do not weaken):
//   The live Teams directory is touched ONLY by read-only operations —
//   fs.openSync(_, 'r') (inside safeCopy) and readdir/stat. We never open it for
//   writing, never create/acquire the LevelDB LOCK, never memory-map, and never
//   pass it to any writing API. All writes go to a fresh os.tmpdir() snapshot dir,
//   enforced by assertUnderTmp(). This is why the reader cannot corrupt Teams.
// ============================================================================

const TMP_ROOT = fs.realpathSync(os.tmpdir());

function assertUnderTmp(p: string): void {
  const r = path.resolve(p);
  if (!r.startsWith(path.resolve(TMP_ROOT) + path.sep)) {
    throw new Error(`refusing to write outside the temp dir: ${r}`);
  }
}

// Copy by reading the source through a Node fd (libuv opens Windows files with
// FILE_SHARE_READ|WRITE|DELETE — maximal sharing), so Teams can read/append/rename/
// delete the source freely while we read. Destination is always under tmp.
function safeCopy(src: string, dest: string): void {
  assertUnderTmp(dest);
  const inFd = fs.openSync(src, 'r');
  try {
    const outFd = fs.openSync(dest, 'w');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let pos = 0,
        n: number;
      while ((n = fs.readSync(inFd, buf, 0, buf.length, pos)) > 0) {
        fs.writeSync(outFd, buf, 0, n);
        pos += n;
      }
    } finally {
      fs.closeSync(outFd);
    }
  } finally {
    fs.closeSync(inFd);
  }
}

// Returns null on error (never a time-based value, so a transient failure doesn't read
// as "changed forever"). log-rotation-aware: fingerprints the newest .log + CURRENT.
function probeFingerprint(dir: string): string | null {
  try {
    const logs = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return `${f}:${st.size}:${st.mtimeMs}`;
      })
      .sort()
      .join('|');
    const cur = fs.existsSync(path.join(dir, 'CURRENT'))
      ? fs.statSync(path.join(dir, 'CURRENT')).mtimeMs
      : 0;
    return `${logs}#${cur}`;
  } catch {
    return null;
  }
}

export interface SessionOptions {
  dir?: string; // explicit leveldb dir (tests / a static copy) — no snapshot/probe
  overrideDir?: string; // TEAMS_LEVELDB_DIR override for discovery
  minDebounceMs?: number;
  maxIncrementals?: number;
  fullIntervalMs?: number;
  // 'copy-reuse' (default): reuse immutable .ldb parses, re-read only the small .log — ~3x
  // faster; falls back to the reparse full path on compaction/schema-change/any doubt.
  // 'reparse' (opt-out): full snapshot + parse every refresh, decode only new records. Simpler,
  // stateless; the equivalence tests prove the two produce identical stores.
  incrementalMode?: 'reparse' | 'copy-reuse';
}

export class Session {
  private cur: Ingested | null = null;
  private snapshotDir: string | null = null;
  private lastProbe: string | null = null;
  private lastIngestAt = 0;
  private lastRebuildMs = 0;
  private lastFullAt = 0;
  private incrementalsSinceFull = 0;
  private readonly engine: JsEngine = createJsEngine(); // owns the JS copy-reuse parse cache
  private pendingFull = false; // copy-reuse latched a "must full-rebuild" (H-D)
  private readonly minDebounceMs: number;
  private readonly maxIncrementals: number;
  private readonly fullIntervalMs: number;
  private readonly mode: 'reparse' | 'copy-reuse';
  private readonly staticDir?: string;
  private readonly overrideDir?: string;

  constructor(opts: SessionOptions = {}) {
    this.mode = opts.incrementalMode ?? 'copy-reuse';
    this.minDebounceMs = opts.minDebounceMs ?? 15_000;
    this.maxIncrementals = opts.maxIncrementals ?? MAX_INCREMENTALS;
    this.fullIntervalMs = opts.fullIntervalMs ?? FULL_INTERVAL_MS;
    this.staticDir = opts.dir;
    this.overrideDir = opts.overrideDir;
  }

  private resolveLiveDir(): string {
    const found = discoverTeamsDbs({ override: this.overrideDir });
    if (!found.length)
      throw new Error('No Teams IndexedDB found. Set TEAMS_LEVELDB_DIR to the leveldb dir.');
    return found[0].dir;
  }

  // Fresh, full, point-in-time-ish snapshot of the current .ldb + .log set. Simple and
  // obviously correct (every rebuild re-parses a consistent copy). CURRENT/MANIFEST are NOT
  // copied — the reader scans all tables directly, and skipping them avoids touching the only
  // rename-sensitive files. (v2: reuse immutable .ldb + incremental WAL decode.)
  private snapshot(liveDir: string): { dir: string; lossy: boolean } {
    const dest = fs.mkdtempSync(path.join(TMP_ROOT, 'zaungast-'));
    assertUnderTmp(dest);
    try {
      let lossy = false;
      for (const f of fs.readdirSync(liveDir).filter((f) => /\.(ldb|log)$/.test(f))) {
        if (!copyFileWithRetry(path.join(liveDir, f), path.join(dest, f))) lossy = true;
      }
      return { dir: dest, lossy };
    } catch (e) {
      // listing/reading the source failed (e.g. it vanished) → don't leak our fresh temp dir
      removeTmpDir(dest);
      throw e;
    }
  }

  // COPY-REUSE: mirror the live .ldb+.log set into the EXISTING snapshot dir — copy new .ldb,
  // copy all .log, and DELETE any snapshot .ldb/.log no longer in live. Mirroring exactly is the
  // H1 safeguard: the reused dir can never retain a compaction-deleted .ldb (which would
  // resurrect deleted data). Returns lossy=true if any copy was skipped.
  private snapshotReuse(liveDir: string, dir: string): boolean {
    assertUnderTmp(dir);
    const live = fs.readdirSync(liveDir).filter((f) => /\.(ldb|log)$/.test(f));
    const liveSet = new Set(live);
    let lossy = false;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(ldb|log)$/.test(f) && !liveSet.has(f)) fs.rmSync(path.join(dir, f), { force: true });
    }
    for (const f of live) {
      const src = path.join(liveDir, f),
        dst = path.join(dir, f);
      if (f.endsWith('.ldb')) {
        // .ldb are immutable → skip re-copy only if the dest is a COMPLETE copy (same size). A size
        // mismatch means a prior partial copy (H-A) or — extremely rare — a recreated DB reusing the
        // filename (H-C); either way re-copy. The re-copy changes the dest size, which the JS engine's
        // parse cache self-validates against (dropping the now-stale cached parse) on the next load.
        try {
          const ss = fs.statSync(src),
            ds = fs.existsSync(dst) ? fs.statSync(dst) : null;
          if (ds && ds.size === ss.size) continue;
        } catch {
          /* src vanished → copy will fail → lossy */
        }
      }
      if (!copyFileWithRetry(src, dst)) lossy = true;
    }
    return lossy;
  }

  // Try a copy-reuse incremental. Returns true if it fully handled this refresh (applied or
  // safely skipped); false to defer to the reparse full/incremental path (compaction, backstop
  // due, schema change, or any error) — the safe fallback.
  private tryCopyReuse(): boolean {
    if (this.mode !== 'copy-reuse' || this.staticDir) return false;
    if (!this.cur || !this.cur.state || !this.snapshotDir) return false;
    const now = Date.now();
    if (
      this.incrementalsSinceFull >= this.maxIncrementals ||
      now - this.lastFullAt > this.fullIntervalMs
    )
      return false;

    let liveDir: string;
    try {
      liveDir = this.resolveLiveDir();
    } catch {
      return false;
    }

    const t0 = Date.now();
    try {
      // Snapshot PRODUCTION stays here (mirror live → the persistent snapshot dir; the tmp-safety
      // contract is the Session's). The JS engine then decodes + applies over that dir, reusing its
      // own .ldb parse cache. H-E: snapshotReuse + the engine load are inside the try so a throw
      // (e.g. an rmSync EPERM in the mirror-delete) also falls back to the reparse path, not aborts.
      const lossy = this.snapshotReuse(liveDir, this.snapshotDir);
      if (lossy) {
        this.lastIngestAt = Date.now();
        return true;
      } // lossy mirror → keep current, retry
      // Compaction (a cached .ldb gone) surfaces as reuseRefresh → 'defer' (loadSnapshotReuse detects
      // it + prunes the dead entries so reuse resumes next time): we defer to the shared
      // reparse-incremental refresh, whose fresh full read reconciles the compaction-elided deletions.
      const res = this.engine.reuseRefresh(this.cur, this.snapshotDir);
      if (res === 'defer') return false;
      if (res.kind === 'skipped') {
        this.lastIngestAt = Date.now();
        return true;
      }
      // H-D: a needFull (or a post-COMMIT-throw funneled through it) demands a fresh FULL rebuild,
      // not a reparse-incremental — latch it so refresh() forces a full.
      if (res.kind === 'needFull') {
        this.pendingFull = true;
        return false;
      }
      // 'inplace': the engine mutated the store + advanced its own state; the Session stamps policy.
      this.incrementalsSinceFull++;
      const c = this.cur.store.counts();
      this.cur.meta = {
        ...this.cur.meta,
        asOf: Date.now(),
        refreshMode: 'incremental',
        lastFullAt: this.lastFullAt,
        counts: { conversations: c.conversations, messages: c.messages, people: c.people },
        earliestTs: c.earliestTs,
        lossy: false,
      };
      this.lastProbe = probeFingerprint(liveDir);
      this.lastRebuildMs = Date.now() - t0;
      this.lastIngestAt = Date.now();
      return true;
    } catch {
      this.pendingFull = true;
      return false;
    } // any throw → defer to a reparse FULL rebuild
  }

  // Take a fresh snapshot of the current live files (or use the static dir), then either FULL
  // rebuild or INCREMENTAL apply. The snapshot is fresh every time (simple variant) — a full
  // rebuild always reads a clean, current file set, so deletions are never resurrected.
  private refresh(forceFull: boolean): void {
    // Copy-reuse fast path (opt-in): if it fully handles this refresh, we're done. Otherwise it
    // returns false and we fall through to the proven reparse full/incremental path below.
    if (!forceFull && this.tryCopyReuse()) return;

    const t0 = Date.now();
    let dir: string,
      prevSnap: string | null = null,
      liveDir: string | null = null,
      snapLossy = false;
    if (this.staticDir) {
      dir = this.staticDir;
    } else {
      liveDir = this.resolveLiveDir();
      const s = this.snapshot(liveDir);
      dir = s.dir;
      snapLossy = s.lossy;
      prevSnap = this.snapshotDir;
    }

    const now = Date.now();
    let caughtUp = false; // true only when we fully read + applied the current source

    // A full rebuild off a lossy read would be missing data; if we already hold a good store,
    // keep it and retry next refresh. Accept a lossy full only as a cold start (nothing yet) —
    // but then do NOT mark the source caught-up, so it keeps retrying and the meta stays lossy.
    const doFull = (): void => {
      const next = this.engine.full(dir);
      const lossy = snapLossy || next.lossy;
      if (lossy && this.cur?.meta.schemaMatched) {
        next.store.close();
        return;
      } // keep good store
      const prevStore = this.cur?.store;
      this.cur = next;
      prevStore?.close();
      this.lastFullAt = now;
      this.incrementalsSinceFull = 0;
      this.lastRebuildMs = Date.now() - t0;
      caughtUp = !lossy;
      // (the JS engine clears its own copy-reuse parse cache inside engine.full)
    };

    const wantFull =
      forceFull ||
      this.pendingFull ||
      !this.cur ||
      // JS needs `state` to apply incrementally; native refreshes via its file handle (`native`)
      // instead, so a native store is incremental-capable even though its JS `state` is null.
      (!this.cur.state && !this.cur.native) ||
      this.incrementalsSinceFull >= this.maxIncrementals ||
      now - this.lastFullAt > this.fullIntervalMs;
    this.pendingFull = false;

    try {
      if (wantFull) {
        doFull();
      } else if (snapLossy) {
        // lossy snapshot → do NOT run incremental (deletion reconcile can't be trusted); keep current
      } else if (this.cur!.native) {
        // Native incremental: Rust reads the (static) snapshot `dir`, writes a fresh .db as a delta
        // of the previous file, and we swap to it. needFullRebuild → full; skipped (lossy) → keep.
        let handled = false;
        try {
          const res = nativeRefresh(dir, this.cur!.native);
          if (res.kind === 'skipped') {
            handled = true; // lossy → keep current, retry
          } else if (res.kind === 'needFullRebuild') {
            doFull();
            handled = true;
          } else {
            const prevStore = this.cur!.store;
            this.cur = {
              store: res.store,
              meta: { ...res.meta, lastFullAt: this.lastFullAt },
              state: null,
              lossy: false,
              native: res.native,
            };
            prevStore.close(); // closing the old store deletes its temp .db dir
            this.incrementalsSinceFull++;
            this.lastRebuildMs = Date.now() - t0;
            caughtUp = true;
            handled = true;
          }
        } catch {
          /* any throw → full rebuild; never leave a torn native store */
        }
        if (!handled) doFull();
      } else {
        let handled = false;
        try {
          // JS incremental via jsEngine (mutates the store + advances state in place); the Session
          // owns the policy re-stamp (meta + counters) on a successful 'inplace' apply.
          const res = this.engine.refresh(this.cur!, dir);
          if (res.kind === 'skipped') {
            handled = true;
          } // lossy read → keep current, retry
          else if (res.kind === 'needFull') {
            doFull();
            handled = true;
          } else if (res.kind === 'inplace') {
            this.incrementalsSinceFull++;
            const c = this.cur!.store.counts();
            this.cur!.meta = {
              ...this.cur!.meta,
              asOf: Date.now(),
              refreshMode: 'incremental',
              lastFullAt: this.lastFullAt,
              counts: { conversations: c.conversations, messages: c.messages, people: c.people },
              earliestTs: c.earliestTs,
              lossy: false,
            };
            caughtUp = true;
            handled = true;
          }
        } catch {
          /* R2: any throw → full rebuild; never leave a half-mutated store */
        }
        if (!handled) doFull();
      }
    } finally {
      // Always reconcile the snapshot dir, even on a throw, so a fresh snapshot is never leaked.
      if (!this.staticDir) {
        this.snapshotDir = dir;
        // Only mark the source "up to date" when we fully read AND applied it — a lossy build
        // must not look like success (else a static corrupt source would never be retried).
        if (caughtUp && liveDir) this.lastProbe = probeFingerprint(liveDir);
        if (prevSnap && prevSnap !== dir) removeTmpDir(prevSnap);
      }
      this.lastIngestAt = Date.now();
    }
  }

  private debounceMs(): number {
    return Math.max(this.minDebounceMs, 5 * this.lastRebuildMs);
  }

  // Kick off the first (full) ingest eagerly after the MCP handshake.
  warmUp(): void {
    if (!this.cur) {
      try {
        this.refresh(true);
      } catch {
        /* first get() will surface it */
      }
    }
  }

  get(): Ingested & { staleProbeDeferred: boolean } {
    if (!this.cur) {
      this.refresh(true);
      return { ...this.cur!, staleProbeDeferred: false };
    }
    let deferred = false;
    if (!this.staticDir) {
      try {
        const probe = probeFingerprint(this.resolveLiveDir());
        if (probe !== null && probe !== this.lastProbe) {
          if (Date.now() - this.lastIngestAt >= this.debounceMs()) this.refresh(false);
          else deferred = true;
        }
      } catch {
        /* keep serving current data */
      }
    }
    return { ...this.cur!, staleProbeDeferred: deferred };
  }

  /** @internal — test helper: run one refresh cycle and return the resulting meta. */
  refreshNow(forceFull = false): Ingested['meta'] {
    this.refresh(forceFull);
    return this.cur!.meta;
  }

  /** @internal — test helper: the current store, without triggering a probe/refresh. */
  getStore(): Ingested['store'] {
    return this.cur!.store;
  }

  // The leveldb dir currently backing the store — the snapshot copy, or the static dir.
  // Used by describe_schema to sample the raw DB (never the live dir directly).
  currentDir(): string {
    if (this.staticDir) return this.staticDir;
    if (!this.snapshotDir) {
      this.refresh(true);
    }
    return this.snapshotDir!;
  }

  dispose(): void {
    this.cur?.store.close();
    if (this.snapshotDir) removeTmpDir(this.snapshotDir);
  }
}

// Returns true if copied, false if skipped (file vanished / unshareable). A skip makes the
// snapshot lossy, so the caller must not treat a resulting missing chain as a deletion.
// On failure the (possibly partial) dest is removed (H-A) so a later size/existence check never
// mistakes a truncated copy for a complete one.
function copyFileWithRetry(src: string, dest: string): boolean {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      safeCopy(src, dest);
      return true;
    } catch (e: any) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        /* nothing to clean */
      }
      if (['ENOENT', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) {
        if (attempt < 2) continue;
        return false;
      }
      throw e;
    }
  }
  return false;
}

function removeTmpDir(dir: string): void {
  assertUnderTmp(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
