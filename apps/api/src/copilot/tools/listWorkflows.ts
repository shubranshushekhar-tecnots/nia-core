import { z } from "zod";
import { getSidebarProjects } from "../../services/projects.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

const InputSchema = z.object({});
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof getSidebarProjects>>;

/**
 * Copilot agent (Part 2, read tier). Thin passthrough to getSidebarProjects
 * (the same call the app shell's sidebar uses) — flattened for the model's
 * summary into "project > workflow" pairs; render carries the full nested
 * shape unchanged for the UI.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "list_workflows",
  description: "Lists every project and its workflows (id, name, status) in the current workspace.",
  tier: "read",
  inputSchema: InputSchema,
  handler: async (ctx) => getSidebarProjects(ctx.supabase, ctx.user.scope),
  summarize: (output) => {
    const total = output.reduce((n, p) => n + p.workflows.length, 0);
    if (total === 0) return "No workflows exist in this workspace yet.";
    const lines = output.flatMap((p) => p.workflows.map((w) => `${p.name} > ${w.name} (${w.status}, id: ${w.id})`));
    return `${total} workflow(s) across ${output.length} project(s): ${lines.join("; ")}`;
  },
  render: (output) => ({ kind: "workflows_list", payload: output }),
};

registerTool(tool);
