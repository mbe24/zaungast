#!/usr/bin/env bash
# Build + run a native harness binary INSIDE a Linux container (the host blocks executing freshly-
# built native binaries; a container's own execution isn't subject to that policy, and byte-parsing
# + crc32c digests are platform-independent, so a Linux build matches the TS/Windows oracle exactly).
# ONLY runs inside the container — never a host build step; the project builds cross-platform via cargo.
#
# Invoked by harness/run.mjs with the shared runner convention (native-runner.mjs): /work mounted
# read-write, a cargo-registry volume AND a target-cache volume, and CARGO_TARGET_DIR=/tmp/target. The
# build therefore happens IN PLACE (no copy to /build) and writes only into the target volume, so it is
# cached across runs instead of recompiling the crate from scratch every layer.
#
#   docker run --rm -v "<repo>:/work" -v <registry-vol> -v <target-vol> -e CARGO_TARGET_DIR=/tmp/target \
#     rust:1-slim-bookworm bash /work/packages/libzaungast-native/harness/incontainer.sh <dir> <bin> <perfile|whole>
# Emits digests on stdout; build log + any bin panic go to stderr (surfaced, never swallowed).
set -euo pipefail
DATA="${1:?usage: incontainer.sh <leveldb-dir> <bin> <perfile|whole> [extra args...]}"
BIN="${2:?bin name}"
MODE="${3:-perfile}"
EXTRA=("${@:4}") # any trailing args passed straight to the bin (e.g. the mapping path)
cd /work/packages/libzaungast-native
cargo build --release --features harness >&2 # `harness` feature enables the diff [[bin]] targets
BIN_PATH="${CARGO_TARGET_DIR:-target}/release/$BIN"
# stdout = the digest (captured by run.mjs); the bin's OWN stderr is left attached to the console so a
# panic surfaces instead of producing an empty digest + a confusing comparator mismatch.
if [ "$MODE" = "whole" ]; then
  "$BIN_PATH" "$DATA" "${EXTRA[@]}"
else
  for f in "$DATA"/*.ldb; do
    printf '%s\t' "$(basename "$f")"
    "$BIN_PATH" "$f"
  done
fi
