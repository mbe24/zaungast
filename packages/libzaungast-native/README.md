# libzaungast-native (WIP)

Optional **Rust accelerator** for `libzaungast` (the native ingest-to-file path — Rust reads
the Teams leveldb dir and writes the ChatStore SQLite file; the TS `libzaungast` opens it read-only).
`libzaungast` works fully **without** this package (pure TS, zero deps); installing this only makes
ingest faster. End users get **prebuilt** per-platform binaries — no Rust, no cargo, no Docker.

## Developing (normal machine — Docker NOT required)

```
cd packages/libzaungast-native
cargo build --release        # build scripts (serde_json, later rusqlite) run natively — fine
cargo test                   # unit tests run natively
```

Cross-language differential harness (verifies the Rust readers byte-for-byte against the TS reader):

```
node packages/libzaungast-native/harness/run.mjs <leveldb-dir> --layer sstable|snapshot|ssv|fp
```

It defaults to `ZAUNGAST_NATIVE_RUNNER=auto`: **runs locally** (build + run the binary directly), and
only falls back to Docker if the OS blocks executing freshly-built binaries *and* Docker is present.
On a normal dev machine `auto` == local, so you never touch Docker.

## The Docker fallback (locked-down environments only)

Some hardened environments (e.g. the CI/agent sandbox this was bootstrapped in) block executing
freshly-built, unsigned binaries — and, as a side effect, cargo **build scripts** — everywhere on the
host. There, set `ZAUNGAST_NATIVE_RUNNER=docker` (or rely on `auto`'s fallback): the harness builds
and runs the reader inside a Linux container (`ZAUNGAST_NATIVE_IMAGE`, default `rust:1-slim-bookworm`).
Byte-parsing + crc32c digests are platform-independent, so a Linux build matches the TS/Windows
oracle exactly. `harness/incontainer.sh` is bash **because it only ever runs inside that container** —
it is not a host build step; the crate itself builds cross-platform via plain cargo/napi.

This Docker path is a **dev/test convenience for restricted hosts only**. It is never part of the
shipped package, never required on a normal machine, and never seen by end users.
