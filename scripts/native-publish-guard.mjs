// prepublishOnly guard for libzaungast-native. The native package ships ONLY through the gated
// release.yml native jobs, which set ZAUNGAST_SHIP_NATIVE=1. Any other publish path — a manual
// `npm publish` in the package dir, or a workspace-wide publish from the repo root — must refuse, so
// the optional native accelerator can never go out by accident (e.g. before its prebuilts exist).
// Kept in a script (not an inline `node -e`) to avoid shell-quoting hazards in package.json.
if (process.env.ZAUNGAST_SHIP_NATIVE !== '1') {
  console.error(
    'Refusing to publish libzaungast-native: it ships only through the gated release.yml native jobs ' +
      '(which set ZAUNGAST_SHIP_NATIVE=1). A manual or workspace-wide publish must not include it.',
  );
  process.exit(1);
}
