import { z } from "zod";
import { applyPlanDiff } from "../../services/copilotDiffApply.js";
import { registerTool } from "../registry.js";
import type { ToolDefinition } from "../types.js";

// `diff` is deliberately z.unknown(), not schemas' PlanDiff (whose
// z.default()-bearing fields give it a wider Input than Output type,
// incompatible with ToolDefinition's inputSchema: z.ZodType<TInput>
// requiring Input===Output) — applyPlanDiff already calls
// PlanDiff.parse(input.diff) itself as its own real validation, so nothing
// here skips that check.
const InputSchema = z.object({ workflowId: z.string().uuid(), diff: z.unknown(), prompt: z.string().optional() });
type Input = z.infer<typeof InputSchema>;
type Output = Awaited<ReturnType<typeof applyPlanDiff>>;

/**
 * Copilot agent (Part 2, edit tier). Direct passthrough to the existing
 * PlanDiff apply flow (services/copilotDiffApply.ts) — the same code path
 * the drawer's "Approve" button already uses. Reversible via revert_plan
 * (appliedPlanId is in the output). No new persistence mechanism.
 */
const tool: ToolDefinition<Input, Output> = {
  name: "change_graph",
  description:
    "Applies a PlanDiff (add/remove/update nodes, edges, or transform steps) to a workflow's graph. Reversible with revert_plan. " +
    "diff.summary (a short human-readable description of the change) is required. diff.baseGraphVersion is REQUIRED and MUST be " +
    "set to the exact graph version from get_workflow's most recent result for this workflow (never omit it — omitting it silently " +
    "defaults to 0 and will be rejected as stale for any workflow already past version 0). Call get_workflow first if you don't " +
    "already know the current version. diff.ops is REQUIRED and MUST contain at least one operation describing the actual change " +
    "— never omit it or leave it empty (it silently defaults to [], which applies successfully but changes nothing). Each op is " +
    "one of: addNode({kind:'addNode',node}), removeNode({kind:'removeNode',nodeId,before}), updateNode({kind:'updateNode',nodeId," +
    "before,after}), addEdge({kind:'addEdge',edge}), removeEdge({kind:'removeEdge',edgeId,before}), addStep({kind:'addStep'," +
    "nodeId,stepId,step,index}), removeStep({kind:'removeStep',nodeId,stepId,before,index}), updateStep({kind:'updateStep',nodeId," +
    "stepId,before,after}), moveStep({kind:'moveStep',nodeId,stepId,fromIndex,toIndex}). A transform node's `step` (for addStep/" +
    "updateStep) is one of filter/computed_field/drop_fields/aggregate/to_json/flatten; a filter step's `expr` is a boolean " +
    "expression tree, e.g. `salary > 100000` is " +
    '{"kind":"comparison","op":"gt","left":{"kind":"field","name":"salary"},"right":{"kind":"literal","value":100000}} ' +
    "(comparison ops: eq/neq/gt/gte/lt/lte; combine with {\"kind\":\"logical\",\"op\":\"and\"|\"or\"|\"not\",\"args\":[...]}). " +
    "Example full diff adding that filter to transform node \"t1\" at graph version 3: " +
    '{"summary":"Filter salary > 100000","baseGraphVersion":3,"ops":[{"kind":"addStep","nodeId":"t1","stepId":"step-1",' +
    '"step":{"kind":"filter","expr":{"kind":"comparison","op":"gt","left":{"kind":"field","name":"salary"},' +
    '"right":{"kind":"literal","value":100000}}},"index":0}]}.',
  tier: "edit",
  inputSchema: InputSchema,
  handler: async (ctx, input) =>
    applyPlanDiff(ctx.withUser, ctx.user.scope, input.workflowId, { diff: input.diff, prompt: input.prompt }),
  summarize: (output) => `Applied plan ${output.appliedPlanId}, graph is now at version ${output.version}.`,
  render: (output) => ({ kind: "graph_applied", payload: output }),
};

registerTool(tool);
