// electron-builder afterPack hook. `productName` (electron-builder.yml) is
// "Nia Core Agent", so the bundle folder/exe name and Info.plist's
// CFBundleName/CFBundleDisplayName already come out as "Nia Core Agent" by
// default -- this hook just pins those two macOS-visible display strings
// (Dock tooltip, Cmd+Tab switcher, menu bar app name) explicitly so a future
// productName change can't silently drift the Dock-visible name. macOS only.
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
