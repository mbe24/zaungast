// Build script. Only the `napi` feature needs setup (napi-build injects the platform linker args
// so the cdylib resolves N-API symbols against the host Node at load time). Without the feature this
// is a no-op, so the default harness/CI build pulls in no napi build-dependency work.
fn main() {
    #[cfg(feature = "napi")]
    napi_build::setup();
}
