import { contentTypeFor, loadUiAsset } from "./staticAssets.js";
import type { StaticAsset, StaticHandler } from "./router.js";

/**
 * Shown at `/` instead of the real app when there's no valid session --
 * i.e. the page was opened by hand (bookmark, typed URL) rather than via
 * `nia-agent open`'s OTC handoff. Deliberately tiny and inline (no JS,
 * no dependency on the UI bundle having built successfully) so it can
 * never itself fail to render.
 */
const NO_SESSION_HTML = Buffer.from(
  `<!doctype html><html><head><meta charset="utf-8"><title>Nia Core Agent</title></head>` +
    `<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;` +
    `align-items:center;justify-content:center;height:100vh;margin:0;background:#131A26;color:#FAF7F2">` +
    `<p>Open Nia Core Agent again from the Start menu / Applications.</p></body></html>`,
  "utf8",
);

/**
 * Builds the `createRouter` `staticHandler`: `/` serves the real app
 * shell only with a valid session, otherwise the plain fallback page
 * above; every other static path (JS/CSS/fonts/favicon/the built UI's
 * own asset files) serves unconditionally -- none of it is sensitive,
 * it's just code, and the app shell itself still can't call any
 * `/ui/api/*` route without a valid session regardless.
 */
export function buildUiStaticHandler(): StaticHandler {
  return async (pathname, hasValidSession): Promise<StaticAsset | undefined> => {
    if (pathname === "/") {
      if (!hasValidSession) return { data: NO_SESSION_HTML, contentType: "text/html; charset=utf-8" };
      const index = await loadUiAsset("index.html");
      if (!index) return { data: NO_SESSION_HTML, contentType: "text/html; charset=utf-8" };
      return { data: index, contentType: "text/html; charset=utf-8" };
    }

    const relPath = pathname.replace(/^\/+/, "");
    const asset = await loadUiAsset(relPath);
    if (!asset) return undefined;
    return { data: asset, contentType: contentTypeFor(relPath) };
  };
}
