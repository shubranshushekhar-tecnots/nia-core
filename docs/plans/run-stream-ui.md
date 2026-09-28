Save this prompt verbatim to docs/plans/run-stream-ui.md. Don't commit.

Bug: a workflow run succeeds (workflow_runs.status = succeeded, 10 rows, BullMQ returnvalue done), but the UI shows a toast "Failed — Lost connection to the run stream". The SSE request (stream?runId=…) returns 200 and closes after ~5.6s. Local dev: web on :3100, api on :4001, browser → web /api/backend rewrite → api SSE route.

Step 0 — clean tree. STOP if dirty.

Step 1 — Diagnose (file:line), no changes:
1. Trace the path: apps/web runsClient EventSource → Next /api/backend rewrite (proxyTimeout, buffering) → apps/api SSE route. What closes the stream at ~5.6s: the api ending it (run finished? no terminal event sent?), the rewrite proxy, or the browser?
2. Does the api send a terminal event (done/succeeded) before closing? Does the client handle it?
3. When the stream closes or errors, why does the UI declare the run Failed instead of reconnecting or fetching the final run status from the API?
4. The destination node badge says "Needs write grant" while the grants check passes: where does the badge get its state, and why is it stale?
STOP and report before fixing if the cause isn't clear.

Design (decided):
- A closed or errored stream is never shown as a failed run. On close/error: fetch the run's real status once; if still running, reconnect (with backoff, max a few tries); if finished, show the real final status.
- The api always sends a terminal event with the final status before closing the stream.
- The grant badge reads the same source of truth as the grants check and updates after confirmation.

Tests (minimal): client logic for stream close → status fetch → correct final state (succeeded shows succeeded; running reconnects). Typecheck every package.

Close-out: files changed, which images need rebuilding. Record in docs/decisions.md. Don't commit.
