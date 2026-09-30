import cors from "cors";
import express from "express";
import { env } from "./env.js";
import { checkConnectorFreshness } from "./lib/connectorFreshness.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { projectsRouter } from "./routes/projects.js";
import { announcementsRouter } from "./routes/announcements.js";
import { workflowsRouter } from "./routes/workflows.js";
import { connectorsRouter } from "./routes/connectors.js";
import { connectionsRouter } from "./routes/connections.js";
import { grantsRouter } from "./routes/grants.js";
import { chatRouter } from "./routes/chat.js";
import { runsRouter } from "./routes/runs.js";
import { copilotAgentRouter } from "./routes/copilotAgent.js";
import { consoleRouter } from "./routes/console.js";
import { billingRouter } from "./routes/billing.js";
import { billingWebhookRouter } from "./routes/billingWebhook.js";
// Copilot agent (Part 1/2): importing this registers every v1 tool
// (registerTool side effect at each module's bottom) before any request
// can reach copilotAgentRouter below.
import "./copilot/tools/index.js";

const app = express();

app.use(
  cors({
    origin: env.WEB_ORIGIN,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Subscription Phase 4, Slice 2: Razorpay's webhook signature is an HMAC
// over the exact raw request bytes — must be captured with express.raw()
// BEFORE the global express.json() below parses (and discards) the
// original body. `type: "*/*"` forces raw capture regardless of Razorpay's
// actual Content-Type (application/json) — express.raw()'s own default
// type filter only matches application/octet-stream, which would silently
// skip parsing here and leave req.body undefined instead of a Buffer. This
// route has no auth middleware of its own (see billingWebhook.ts's header
// comment) — signature verification IS its authentication.
//
// Payments kill switch (env.PAYMENTS_ENABLED, see env.ts): while off, this
// router isn't mounted at all, same "flag off means not mounted" rule
// CONSOLE_ENABLED already follows below. The explicit notFoundHandler in
// the else branch is required, not just "do nothing": without it, a
// delivery to /billing/webhook falls through to billingRouter's own
// kill-switch middleware (mounted below at "/billing", which matches this
// path's prefix too) and gets ITS 503 instead of the 404 a delivery target
// that doesn't exist should return — registering the 404 here, before that
// mount, wins the match first. Either way no RPC call is ever made and
// nothing is written.
if (env.PAYMENTS_ENABLED) {
  app.use("/billing/webhook", express.raw({ type: "*/*" }), billingWebhookRouter);
} else {
  app.all("/billing/webhook", notFoundHandler);
}

app.use(express.json());
app.use(requestLogger);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "@nia/api" });
});

// Step 2 (read path): dashboard/projects/workflows queries ported from
// apps/web/src/lib/dashboard/queries.ts. Write routes (Step 3) not added yet.
app.use("/dashboard", dashboardRouter);
app.use("/projects", projectsRouter);
app.use("/announcements", announcementsRouter);

// runsRouter (POST /workflows/:id/run(/cancel), GET /workflows/:id/run/
// stream — cookie-authenticated, not Bearer, since GET .../run/stream is
// consumed via a browser EventSource which can never attach a custom
// Authorization header) is mounted at the SAME "/workflows" prefix as
// workflowsRouter, but BEFORE it: workflowsRouter has a blanket
// `.use(requireAuth, attachActor)` (Bearer-only) that runs for every
// request matching "/workflows/*" regardless of whether one of its own
// routes matches — so mounted first, it would intercept and 401 these
// cookie-authed run routes before they ever reached runsRouter. Mounting
// runsRouter first lets Express match its three specific routes directly;
// anything else under "/workflows" correctly falls through to
// workflowsRouter right after (runsRouter has no blanket auth of its own —
// see that file's header comment).
app.use("/workflows", runsRouter);
app.use("/workflows", workflowsRouter);

// Connector system (Step 4): install/uninstall, connection CRUD + test,
// write grants. No /execute route yet — that belongs to the workflow
// runner, not this pass (see apps/api/src/services/connections.ts).
app.use("/connectors", connectorsRouter);
app.use("/connections", connectionsRouter);
app.use("/connections/:connectionId/grants", grantsRouter);

// Authenticated billing routes (upgrade preview, checkout creation,
// subscription-status polling). The public webhook counterpart is mounted
// above, before express.json(), with no auth middleware — see
// billingWebhook.ts.
app.use("/billing", billingRouter);

// Console v1 (docs/plans/console-plan.md, build order step 4) — off by
// default (env.CONSOLE_ENABLED); per that step's own spec, "flag off" must
// mean the router isn't mounted at all, not just gated per-route. Mounted
// here, BEFORE chatRouter's "/" mount below: chatRouter has a blanket
// .use(requireCookieAuth, ...) that runs for every request path once
// registered (same reasoning runsRouter's header comment documents for
// workflowsRouter) — a cookie-auth failure there calls next(err), which
// skips straight to the error handler and never reaches a router mounted
// after it, so /console/* must be registered first to get its own
// requireAuth/requireStaff chain a chance to run at all.
if (env.CONSOLE_ENABLED) {
  app.use("/console", consoleRouter);
}

// POST /chat, GET /chat/stream — cookie-authenticated, mounted at "/" LAST
// (chatRouter has a blanket cookie-auth .use() of its own; mounting it at
// "/" before any Bearer-authed router above would intercept and 401 all of
// them the same way workflowsRouter almost did to runsRouter — safe here
// only because every router above it fully owns and responds to its own
// prefix first). See routes/chat.ts for the EventSource/Bearer rationale.
app.use("/", chatRouter);

// Copilot agent (docs/plans/copilot-agent.md) — the new agentic tool-use
// surface, separate from chatRouter's existing single-shot propose/apply
// flow above. Own prefix, own blanket cookie-auth .use(), same reasoning
// as chatRouter for why it's safe to mount here (nothing above owns
// "/copilot-agent").
app.use("/copilot-agent", copilotAgentRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// Exported (not just a local const) so index.test.ts can dynamically
// re-import this module with env.CONSOLE_ENABLED stubbed true/false and
// inspect the resulting server directly — see that file's header comment
// for why a genuine import of this file, not a hand-built substitute app,
// is needed to prove the `if (env.CONSOLE_ENABLED)` line itself gates
// mounting.
export const server = app.listen(env.PORT, () => {
  console.log(`[api] listening on :${env.PORT} (web origin: ${env.WEB_ORIGIN})`);
  // Best-effort, non-blocking: warns if a running connector container's
  // image predates its current source (see connectorFreshness.ts).
  void checkConnectorFreshness();
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// (including any open SSE stream — chat.ts/runs.ts's res.write loops exit
// on their own once the connection closes) drain naturally. A hard timeout
// backstops a request that never finishes on its own.
function shutdown() {
  console.log("[api] shutting down…");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
