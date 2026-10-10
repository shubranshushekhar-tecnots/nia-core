import { AUTO_RETRY_INTERVAL_MS, RETRY_MARKER_URL } from "./constants.js";

/**
 * The "Nia Agent service isn't running" screen. Loaded as a `data:` URL (no network, no preload,
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
<title>Nia Agent</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    height: 100%; background: #0b0b0f; color: #e8e8ec;
    font-family: -apple-system, "Segoe UI", system-ui, sans-serif; text-align: center;
  }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
  p { font-size: 14px; color: #9a9aa5; margin: 0 0 24px; max-width: 360px; }
  a.retry {
    display: inline-block; padding: 10px 20px; border-radius: 8px;
    background: #635bff; color: #fff; text-decoration: none; font-size: 14px; font-weight: 600;
  }
</style>
</head>
<body>
  <h1>Nia Agent service isn't running</h1>
  <p>Open this app again after starting the Nia Agent service, or click Retry -- it also checks again on its own every few seconds.</p>
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
