/**
 * Copilot agent (Part 1/2) — importing this module registers every v1 tool
 * (registerTool is a side effect at each module's bottom, mirroring
 * packages/schemas/src/ops/registry.ts's op-module pattern). Import this
 * file exactly once, before any route that dispatches a tool call, so the
 * registry is fully populated before first use (see index.ts).
 */
import "./listConnections.js";
import "./listWorkflows.js";
import "./getWorkflow.js";
import "./describeSource.js";
import "./getProfile.js";
import "./previewRows.js";
import "./listRuns.js";
import "./getRunStatus.js";
import "./getRunResult.js";
import "./explainLastError.js";
import "./changeGraph.js";
import "./proposeCleaning.js";
import "./setDestination.js";
import "./proposeMapping.js";
import "./revertPlan.js";
import "./startRun.js";
import "./cancelRun.js";
import "./explainWriteGrant.js";
import "./explainSourceRlsPolicy.js";
import "./explainMissingPrivilege.js";
