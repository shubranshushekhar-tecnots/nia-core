import { AUTO_RETRY_INTERVAL_MS, RETRY_MARKER_URL } from "./constants.js";

// 40x40 downscale of the Nia mark (designs/nia core logo/apple-devices/
// AppIcon.appiconset/icon-ios-1024x1024.png), hardcoded as base64 so this
// file stays a pure, dependency-free string builder with no fs reads --
// this page is loaded as a `data:` URL with no bundler/asset pipeline
// available to reference an external image file from.
const LOGO_BASE64 =
  "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";

/**
 * The "Nia Core Agent service isn't running" screen. Loaded as a `data:` URL (no network, no preload,
 * no IPC needed) -- its Retry link/auto-retry timer simply navigate to `RETRY_MARKER_URL`, which
 * window.ts's `will-navigate` handler intercepts and turns into a real retry attempt before it ever
 * reaches navigationGuard. Plain inline `<script>`/`<style>` run fine here: Electron's `sandbox: true`
 * disables Node API access in the renderer, not ordinary page JS/CSS.
 */
export function buildServiceNotRunningHtml(): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Nia Core Agent</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; background: #0b0b0f; color: #e8e8ec;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; text-align: center;
  }
  img.logo { width: 40px; height: 40px; margin-bottom: 16px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 14px; color: #9a9aa5; margin: 0 0 24px; max-width: 360px; }
  a.retry {
    display: inline-block; padding: 10px 20px; border-radius: 8px;
    background: #635bff; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600;
  }
</style>
</head>
<body>
  <img class="logo" src="data:image/png;base64,${LOGO_BASE64}" alt="">
  <h1>Nia Core Agent service isn't running</h1>
  <p>Open this app again after starting the Nia Core Agent service, or click Retry -- it also checks again on its own every few seconds.</p>
  <a class="retry" href="${RETRY_MARKER_URL}">Retry</a>
  <script>
    setTimeout(function () { window.location.href = ${JSON.stringify(RETRY_MARKER_URL)}; }, ${AUTO_RETRY_INTERVAL_MS});
  </script>
</body>
</html>`;
}

export function buildServiceNotRunningDataUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildServiceNotRunningHtml())}`;
}
