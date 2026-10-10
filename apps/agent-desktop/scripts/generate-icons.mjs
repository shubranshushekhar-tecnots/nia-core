#!/usr/bin/env node
// One-off branding asset generator for the Nia Core Agent (Electron shell +
// Windows installer + local UI favicon). NOT run in CI -- every file this
// writes is committed to the repo and reused as-is by build-sea.mjs,
// build-installer.mjs, and electron-builder.yml. Re-run manually only when
// the master logo changes.
//
// Source of truth: designs/nia core logo/apple-devices/AppIcon.appiconset/
// icon-ios-1024x1024.png (1024x1024, squircle+gradient baked in) for
// anything needing the full-color mark, plus that same folder's native
// icon-mac-*.png exports for the .icns (real per-size exports, not one
// bitmap scaled down -- avoids any upscale blur).
//
// Everything here is downscale-only. Nothing is ever stretched up from a
// smaller source.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, cpSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../");
const designsDir = path.join(repoRoot, "designs", "nia core logo", "apple-devices", "AppIcon.appiconset");
const master1024 = path.join(designsDir, "icon-ios-1024x1024.png");

const desktopAssetsDir = path.join(repoRoot, "apps", "agent-desktop", "assets");
const agentUiPublicDir = path.join(repoRoot, "apps", "agent", "ui", "public");
const windowsAssetsDir = path.join(repoRoot, "apps", "agent", "packaging", "windows", "assets");
const contactSheetDir = path.join(os.homedir(), "Desktop", "nia-agent-branding");

const BRAND_PURPLE = "#6a5bdb";
const STATUS_COLORS = { green: "#2ecc71", amber: "#f5a623", grey: "#8a8a93" };

mkdirSync(desktopAssetsDir, { recursive: true });
mkdirSync(windowsAssetsDir, { recursive: true });
rmSync(contactSheetDir, { recursive: true, force: true });
mkdirSync(contactSheetDir, { recursive: true });

const contactSheetEntries = [];
/** `previewBuffer` is a plain PNG to render into the contact sheet -- used when `buffer` itself
 * isn't a format sharp can decode (.ico, .icns, pre-converted .bmp). Defaults to `buffer`. */
async function emit(destPath, buffer, { label, previewBuffer } = {}) {
  writeFileSync(destPath, buffer);
  const sheetName = (label ?? path.basename(destPath)).replace(/[\\/]/g, "_");
  const sheetPath = path.join(contactSheetDir, `${sheetName}.png`);
  // Flatten onto a dark background so transparent/template assets are still legible in the
  // contact sheet (the real files keep their alpha channel).
  await sharp(previewBuffer ?? buffer)
    .flatten({ background: "#1c1c22" })
    .png()
    .toFile(sheetPath);
  contactSheetEntries.push(sheetPath);
}

async function main() {
  console.log(`[generate-icons] master: ${master1024}`);
  if (!existsSync(master1024)) throw new Error(`master icon not found: ${master1024}`);

  // ---- 1. app-icon.png (Linux window/taskbar icon), 512x512 ----
  const png512 = await sharp(master1024).resize(512, 512).png().toBuffer();
  await emit(path.join(desktopAssetsDir, "app-icon.png"), png512);

  // ---- 2. app-icon.ico (Windows), sizes rendered directly from the 1024 master ----
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoBuffers = await Promise.all(icoSizes.map((size) => sharp(master1024).resize(size, size).png().toBuffer()));
  const icoBuffer = await pngToIco(icoBuffers);
  await emit(path.join(desktopAssetsDir, "app-icon.ico"), icoBuffer, {
    label: "app-icon-ico-preview-256",
    previewBuffer: icoBuffers[icoBuffers.length - 1], // 256px png -- sharp can't decode .ico itself
  });

  // ---- 3. app-icon.icns (macOS), built from the native per-size exports via iconutil ----
  const icnsMap = {
    "icon_16x16.png": "icon-mac-16x16.png",
    "icon_16x16@2x.png": "icon-mac-16x16@2x.png",
    "icon_32x32.png": "icon-mac-32x32.png",
    "icon_32x32@2x.png": "icon-mac-32x32@2x.png",
    "icon_128x128.png": "icon-mac-128x128.png",
    "icon_128x128@2x.png": "icon-mac-128x128@2x.png",
    "icon_256x256.png": "icon-mac-256x256.png",
    "icon_256x256@2x.png": "icon-mac-256x256@2x.png",
    "icon_512x512.png": "icon-mac-512x512.png",
    "icon_512x512@2x.png": "icon-mac-512x512@2x.png",
  };
  const iconsetDir = mkdtempSync(path.join(os.tmpdir(), "nia-agent-icon-")) + ".iconset";
  mkdirSync(iconsetDir, { recursive: true });
  for (const [destName, srcName] of Object.entries(icnsMap)) {
    cpSync(path.join(designsDir, srcName), path.join(iconsetDir, destName));
  }
  const icnsOut = path.join(desktopAssetsDir, "app-icon.icns");
  execFileSync("iconutil", ["-c", "icns", iconsetDir, "-o", icnsOut]);
  rmSync(iconsetDir, { recursive: true, force: true });
  contactSheetEntries.push("(app-icon.icns: binary macOS format, not previewable as PNG -- see app-icon.png for the same mark)");

  // ---- 4. Windows/Linux tray dots: clean vector-drawn circles, not the logo glyph ----
  const trayPxSizes = { 16: null, 20: null, 24: null, 32: null };
  for (const [color, hex] of Object.entries(STATUS_COLORS)) {
    for (const size of Object.keys(trayPxSizes).map(Number)) {
      const buf = await dotPng(size, hex);
      await emit(path.join(desktopAssetsDir, sizedTrayName(color, size)), buf, { label: `tray-${color}-${size}` });
      const buf2x = await dotPng(size * 2, hex);
      await emit(path.join(desktopAssetsDir, sizedTrayName(color, size, true)), buf2x, { label: `tray-${color}-${size}@2x` });
    }
    // Keep the plain tray-<color>.png / @2x.png names too (16px base is what
    // trayManager.ts's trayIconPath() resolves for Tray(); nativeImage auto-
    // picks up the @2x sibling for HiDPI).
    await emit(path.join(desktopAssetsDir, `tray-${color}.png`), await dotPng(16, hex), { label: `tray-${color}-base` });
    await emit(path.join(desktopAssetsDir, `tray-${color}@2x.png`), await dotPng(32, hex), { label: `tray-${color}-base@2x` });
  }

  // ---- 5. macOS template tray icon: alpha mask of the white glyph region ----
  const templateSize = 22;
  const [tpl1x, tpl2x] = await Promise.all([
    buildTemplateIcon(master1024, templateSize, false),
    buildTemplateIcon(master1024, templateSize * 2, false),
  ]);
  await emit(path.join(desktopAssetsDir, "trayTemplate.png"), tpl1x);
  await emit(path.join(desktopAssetsDir, "trayTemplate@2x.png"), tpl2x);

  const [tplProblem1x, tplProblem2x] = await Promise.all([
    buildTemplateIcon(master1024, templateSize, true),
    buildTemplateIcon(master1024, templateSize * 2, true),
  ]);
  await emit(path.join(desktopAssetsDir, "trayTemplateProblem.png"), tplProblem1x);
  await emit(path.join(desktopAssetsDir, "trayTemplateProblem@2x.png"), tplProblem2x);

  // ---- 6. apps/agent/ui favicon / logo, 235x235 (matches apps/web/public/logo-mark.png's size) ----
  const logoMark = await sharp(master1024).resize(235, 235).png().toBuffer();
  await emit(path.join(agentUiPublicDir, "logo-mark.png"), logoMark);

  // ---- 7. Windows installer wizard art (MUI_HEADERIMAGE / MUI_WELCOMEFINISHPAGE_BITMAP) ----
  // Header: 150x57, logo on brand-purple background, left-aligned.
  const headerPng = await sharp({ create: { width: 150, height: 57, channels: 4, background: BRAND_PURPLE } })
    .composite([{ input: await sharp(master1024).resize(40, 40).png().toBuffer(), left: 10, top: 8 }])
    .png()
    .toBuffer();
  const headerPngPath = path.join(windowsAssetsDir, "header.png");
  writeFileSync(headerPngPath, headerPng);
  execFileSync("sips", ["-s", "format", "bmp", headerPngPath, "--out", path.join(windowsAssetsDir, "header.bmp")]);
  rmSync(headerPngPath);
  await emit(path.join(contactSheetDir, "installer-header.png"), headerPng, { label: "installer-header" });

  // Welcome/finish side bitmap: 164x314, logo centered on brand-purple background.
  const wizardPng = await sharp({ create: { width: 164, height: 314, channels: 4, background: BRAND_PURPLE } })
    .composite([{ input: await sharp(master1024).resize(100, 100).png().toBuffer(), left: 32, top: 107 }])
    .png()
    .toBuffer();
  const wizardPngPath = path.join(windowsAssetsDir, "wizard.png");
  writeFileSync(wizardPngPath, wizardPng);
  execFileSync("sips", ["-s", "format", "bmp", wizardPngPath, "--out", path.join(windowsAssetsDir, "wizard.bmp")]);
  rmSync(wizardPngPath);
  await emit(path.join(contactSheetDir, "installer-wizard.png"), wizardPng, { label: "installer-wizard" });

  console.log(`[generate-icons] done. Contact sheet: ${contactSheetDir} (${contactSheetEntries.length} previews)`);
}

function sizedTrayName(color, size, retina = false) {
  return `tray-${color}-${size}${retina ? "@2x" : ""}.png`;
}

async function dotPng(size, hex) {
  const r = Math.max(1, Math.round(size / 2) - 1);
  const c = size / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${c}" cy="${c}" r="${r}" fill="${hex}"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Builds a macOS "template" tray icon: a black-on-transparent silhouette of
 * the logo's white glyph (the squircle/gradient background is discarded),
 * matching Electron/macOS's convention of auto-recoloring any image whose
 * filename contains "Template" for light/dark menu bars. `problem` adds a
 * small filled circle + exclamation mark badge in the bottom-right corner.
 */
async function buildTemplateIcon(sourcePath, size, problem) {
  // The glyph is pure white on the purple squircle -- threshold on
  // brightness to get a single-channel mask of just the glyph (0 or 255),
  // then build a black RGBA image using that mask as the alpha channel
  // directly (template images must be black shapes + alpha).
  const { data: maskData } = await sharp(sourcePath)
    .resize(size, size)
    .greyscale()
    .threshold(200)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgba = Buffer.alloc(size * size * 4); // RGB stays 0 (black); alpha set below
  for (let i = 0; i < size * size; i++) rgba[i * 4 + 3] = maskData[i];
  let glyph = await sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toBuffer();

  if (problem) {
    const badgeSize = Math.round(size * 0.52);
    const badgeSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${badgeSize}" height="${badgeSize}">
      <circle cx="${badgeSize / 2}" cy="${badgeSize / 2}" r="${badgeSize / 2 - 1}" fill="black"/>
      <rect x="${badgeSize / 2 - 1}" y="${badgeSize * 0.22}" width="2" height="${badgeSize * 0.32}" fill="white"/>
      <circle cx="${badgeSize / 2}" cy="${badgeSize * 0.68}" r="1.3" fill="white"/>
    </svg>`;
    const badge = await sharp(Buffer.from(badgeSvg)).png().toBuffer();
    glyph = await sharp(glyph)
      .composite([{ input: badge, left: size - badgeSize, top: size - badgeSize }])
      .png()
      .toBuffer();
  }
  return glyph;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
