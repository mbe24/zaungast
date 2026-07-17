#!/usr/bin/env bash
# Build + run the native reader INSIDE a Linux container (the host blocks executing freshly-built
# native binaries; a container's own execution isn't subject to that policy, and the byte-parsing +
# crc32c digest are platform-independent, so a Linux build matches the TS/Windows oracle exactly).
#
# Usage (from the host, repo mounted read-only at /work):
#   docker run --rm -v "<repo>:/work:ro" rust:1-slim-bookworm bash /work/packages/libzaungast-native/harness/incontainer.sh <leveldb-dir-under-/work>
# Emits, per .ldb on stdout:  <file>\t<count>\t<clean|lossy>\t<crc32c>   (build log → stderr)
set -euo pipefail
DATA="${1:?usage: incontainer.sh <leveldb-dir>}"
# copy source to a writable dir (the /work mount is read-only; avoids writing Cargo.lock/target there)
mkdir -p /build/src
cp /work/packages/libzaungast-native/Cargo.toml /build/
cp -r /work/packages/libzaungast-native/src/. /build/src/
cd /build
cargo build --release --bin difftable >&2
for f in "$DATA"/*.ldb; do
  printf '%s\t' "$(basename "$f")"
  ./target/release/difftable "$f" 2>/dev/null
done
