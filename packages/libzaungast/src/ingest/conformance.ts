// The conformance version the TS reader was built against. An external ingest engine (e.g. the
// native accelerator) is trusted only when its addon's conformanceVersion() matches this. Bump it in
// lockstep with the Rust bindings (libzaungast-native) whenever native output could diverge from the
// TS reference. Exposed to engine authors via the 'libzaungast/engine-spi' subpath.
export const EXPECTED_CONFORMANCE = 1;
