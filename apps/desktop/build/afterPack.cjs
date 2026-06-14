// electron-builder afterPack hook: ad-hoc sign the macOS app.
//
// Without an Apple Developer ID, electron-builder skips app signing and leaves only the
// linker's ad-hoc signature on the main binary, with the bundle resources unsealed. That
// signature is INVALID (codesign --verify fails), and on Apple Silicon a downloaded copy
// then fails to open as "eigenheim is damaged". A proper ad-hoc signature (codesign -s -)
// seals the whole bundle so it is valid and runnable; the user still clears the download
// quarantine on first launch (see the Install section in README.md).
//
// Runs on macOS only (codesign is darwin-only). No-op for Windows/Linux packing.
const { execSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  const quoted = JSON.stringify(appPath);
  console.log(`  • afterPack: ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - ${quoted}`, { stdio: "inherit" });
  // Fail the build loudly if the signature is not valid (would resurface as "damaged").
  execSync(`codesign --verify --deep --strict ${quoted}`, { stdio: "inherit" });
};
