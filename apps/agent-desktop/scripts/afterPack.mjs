// electron-builder afterPack hook. The bundle folder/exe name must stay
// "Nia Agent.app" (see the branding plan's scope decision #1 -- renaming it
// would ripple into apps/agent/packaging/macos' build-bundle.mjs and
// install.sh, which reference that exact name), but the macOS-visible
// *display* strings (Dock tooltip, Cmd+Tab switcher, menu bar app name)
// come from Info.plist's CFBundleName/CFBundleDisplayName, which
// electron-builder otherwise fills in from `productName` ("Nia Agent").
// Patches just those two keys to "Nia Core Agent" post-package, macOS only.
// CFBundleIdentifier (com.nia.agent.desktop) is intentionally left alone --
// changing it would be a breaking app-identity change, not branding.
import { execFileSync } from "node:child_process";
import path from "node:path";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const plistPath = path.join(context.appOutDir, appName, "Contents", "Info.plist");

  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("plutil", ["-replace", key, "-string", "Nia Core Agent", plistPath]);
  }
  console.log(`[afterPack] set CFBundleName/CFBundleDisplayName to "Nia Core Agent" in ${plistPath}`);
}
