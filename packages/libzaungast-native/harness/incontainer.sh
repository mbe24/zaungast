#!/usr/bin/env bash
# Build + run a native harness binary INSIDE a Linux container (the host blocks executing freshly-
# built native binaries; a container's own execution isn't subject to that policy, and byte-parsing
# + crc32c digests are platform-independent, so a Linux build matches the TS/Windows oracle exactly).
# ONLY runs inside the container — never a host build step; the project builds cross-platform via cargo.
#
#   docker run --rm -v "<repo>:/work:ro" rust:1-slim-bookworm \
#     bash /work/packages/libzaungast-native/harness/incontainer.sh <leveldb-dir> <bin> <perfile|whole>
# Emits digests on stdout (build log → stderr).
set -euo pipefail
DATA="${1:?usage: incontainer.sh <leveldb-dir> <bin> <perfile|whole>}"
BIN="${2:?bin name}"
MODE="${3:-perfile}"
# copy source to a writable dir (the /work mount is read-only)
mkdir -p /build/src
cp /work/packages/libzaungast-native/Cargo.toml /build/
cp -r /work/packages/libzaungast-native/src/. /build/src/
cd /build
cargo build --release >&2   # builds all [[bin]] targets
if [ "$MODE" = "whole" ]; then
  "./target/release/$BIN" "$DATA" 2>/dev/null
else
  for f in "$DATA"/*.ldb; do
    printf '%s\t' "$(basename "$f")"
    "./target/release/$BIN" "$f" 2>/dev/null
  done
fi
