// Type surface for native-runner.mjs (a plain-JS script). Tests import `resolveLevelDbDir` from it and
// are typechecked (typecheck:test), so NodeNext resolution needs this sidecar (.d.mts ↔ .mjs) or the
// import trips TS7016. Keep in sync with native-runner.mjs's exports.

/** Absolute path to the repo root. */
export const REPO: string;
/** Absolute path to the libzaungast-native crate. */
export const CRATE: string;
/** The selected runner: 'auto' | 'local' | 'docker' (from ZAUNGAST_NATIVE_RUNNER, lowercased). */
export const RUNNER: string;
/** The Docker image used for the containerized Rust tasks. */
export const IMAGE: string;
/** Named cargo-registry cache volume. */
export const REGISTRY_VOLUME: string;
/** Named cargo target-dir cache volume. */
export const TARGET_VOLUME: string;

/** True if a Docker daemon is reachable. */
export function dockerAvailable(): boolean;

/** The shared `docker run …` argument prefix (everything up to the image). */
export function dockerRunArgs(opts?: { env?: Record<string, string> }): string[];

/**
 * Resolve a leveldb dir from: the dir itself (has a CURRENT file); a parent that contains a
 * *.leveldb subdir; or a bare data date under <repo>/data/. Returns an absolute path, or null.
 */
export function resolveLevelDbDir(input: string | null | undefined): string | null;

/** Translate a host path under REPO to its /work/<rel> container path. Throws if outside REPO. */
export function toContainerPath(hostAbs: string): string;

/** Run the local or Docker branch per RUNNER, with auto-fallback to Docker on local failure. */
export function runWithFallback<T>(
  localFn: () => T,
  dockerFn: () => T,
  opts?: { label?: string },
): T;
