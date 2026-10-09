import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@nia/ui/theme.css";
import "./ui.css";
import { App } from "./App";
import { exchangeOtcForSession } from "./apiClient";

/**
 * `nia-agent open` navigates the OS browser to `/?otc=<code>` -- there is
 * no session cookie yet (router.ts's static handler lets this exact page
 * load anyway, see its doc comment), so before rendering the real app we
 * trade that one-time code for a session via `POST /ui/session`, then
 * strip it from the URL (it's single-use and 60s-TTL, but it shouldn't
 * linger in browser history regardless). A bare `/` with an existing
 * session (reopening a bookmark, a refresh) has no `otc` and skips this.
 */
async function bootstrap() {
  const url = new URL(window.location.href);
  const otc = url.searchParams.get("otc");
  let bootError: string | undefined;

  if (otc) {
    try {
      await exchangeOtcForSession(otc);
    } catch (err) {
      bootError = err instanceof Error ? err.message : "That code has expired or already been used.";
    }
    url.searchParams.delete("otc");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App bootError={bootError} />
    </StrictMode>,
  );
}

void bootstrap();
