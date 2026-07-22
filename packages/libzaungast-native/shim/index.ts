// libzaungast-native public surface: the native ingest engine as an injectable factory. This package
// is the optional Rust accelerator (the native ingest-to-file path) for libzaungast — install it alongside libzaungast to opt
// into native ingest. It exposes exactly one thing: `createNativeEngine()`, which returns an
// `IngestEngine` (from libzaungast's engine-spi) ready to inject into openStore / openLiveStore, or a
// `{ unavailable }` reason when the addon is absent or fails the conformance handshake. The consumer
// decides fallback; libzaungast never depends on this package.
export { createNativeEngine, type NativeUnavailable } from './native.js';
