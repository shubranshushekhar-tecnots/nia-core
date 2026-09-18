import cors from "cors";
import express from "express";
import { env } from "./env.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { requestLogger } from "./middleware/requestLogger.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { projectsRouter } from "./routes/projects.js";
import { workflowsRouter } from "./routes/workflows.js";
import { connectorsRouter } from "./routes/connectors.js";
import { connectionsRouter } from "./routes/connections.js";
import { grantsRouter } from "./routes/grants.js";
import { chatRouter } from "./routes/chat.js";
import { runsRouter } from "./routes/runs.js";

const app = express();

app.use(
  cors({
    origin: env.WEB_ORIGIN,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());
app.use(requestLogger);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "@nia/api" });
});

// Step 2 (read path): dashboard/projects/workflows queries ported from
// apps/web/src/lib/dashboard/queries.ts. Write routes (Step 3) not added yet.
app.use("/dashboard", dashboardRouter);
app.use("/projects", projectsRouter);

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

// POST /chat, GET /chat/stream — cookie-authenticated, mounted at "/" LAST
// (chatRouter has a blanket cookie-auth .use() of its own; mounting it at
// "/" before any Bearer-authed router above would intercept and 401 all of
// them the same way workflowsRouter almost did to runsRouter — safe here
// only because every router above it fully owns and responds to its own
// prefix first). See routes/chat.ts for the EventSource/Bearer rationale.
app.use("/", chatRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`[api] listening on :${env.PORT} (web origin: ${env.WEB_ORIGIN})`);
});
