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
app.use("/workflows", workflowsRouter);

// Connector system (Step 4): install/uninstall, connection CRUD + test,
// write grants. No /execute route yet — that belongs to the workflow
// runner, not this pass (see apps/api/src/services/connections.ts).
app.use("/connectors", connectorsRouter);
app.use("/connections", connectionsRouter);
app.use("/connections/:connectionId/grants", grantsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
  console.log(`[api] listening on :${env.PORT} (web origin: ${env.WEB_ORIGIN})`);
});
