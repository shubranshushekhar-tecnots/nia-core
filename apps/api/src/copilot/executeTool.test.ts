import { describe, it, expect, vi, beforeEach } from "vitest";
import { z } from "zod";

/**
 * Subscription Phase 2, Slice 6: executeTool.ts's pre-flight gate for
 * workflow-scoped tools. requireWorkflowAccess.ts's own rules (viewer /
 * non-member refused, admin/owner/individual pass) are covered there —
 * this file only proves executeTool actually calls the gate before the
 * handler runs, and that a refusal stops the handler from running at all
 * (never a partial/silent execution).
 */

const requireWorkflowAccessMock = vi.fn();
const resolveWorkflowIdForRunMock = vi.fn();
vi.mock("./requireWorkflowAccess.js", () => ({
  requireWorkflowAccess: (...args: unknown[]) => requireWorkflowAccessMock(...args),
  resolveWorkflowIdForRun: (...args: unknown[]) => resolveWorkflowIdForRunMock(...args),
}));

const auditToolCallMock = vi.fn();
vi.mock("./audit.js", () => ({
  auditToolCall: (...args: unknown[]) => auditToolCallMock(...args),
}));

import { registerTool, __clearRegistryForTests } from "./registry.js";
import { executeTool } from "./executeTool.js";
import type { ActingUser } from "./types.js";
import { AppError } from "../lib/appError.js";

const user: ActingUser = {
  userId: "11111111-1111-1111-1111-111111111111",
  scope: { orgId: "22222222-2222-2222-2222-222222222222" },
  actor: {
    userId: "11111111-1111-1111-1111-111111111111",
    email: "member@example.com",
    fullName: null,
    org: { id: "22222222-2222-2222-2222-222222222222", name: "Acme", slug: "acme" },
    role: "member",
  },
};

const handlerMock = vi.fn();
const WORKFLOW_ID = "33333333-3333-3333-3333-333333333333";

beforeEach(() => {
  __clearRegistryForTests();
  requireWorkflowAccessMock.mockReset();
  resolveWorkflowIdForRunMock.mockReset();
  auditToolCallMock.mockReset();
  handlerMock.mockReset();

  registerTool({
    name: "get_workflow",
    description: "test tool",
    tier: "read",
    inputSchema: z.object({ workflowId: z.string() }),
    handler: handlerMock,
    summarize: () => "summary",
    render: () => ({ kind: "test", payload: {} }),
  });
});

describe("executeTool — workflow-project-membership gate (Subscription Phase 2, Slice 6)", () => {
  it("refuses the call and never runs the handler when requireWorkflowAccess rejects", async () => {
    requireWorkflowAccessMock.mockRejectedValueOnce(new AppError(403, "NOT_PROJECT_MEMBER", "You are not a member of this workflow's project."));

    await expect(executeTool({} as never, user, "get_workflow", { workflowId: WORKFLOW_ID })).rejects.toMatchObject({
      statusCode: 403,
      code: "NOT_PROJECT_MEMBER",
    });

    expect(requireWorkflowAccessMock).toHaveBeenCalledWith({}, user, WORKFLOW_ID, { write: false });
    expect(handlerMock).not.toHaveBeenCalled();
    expect(auditToolCallMock).not.toHaveBeenCalled();
  });

  it("runs the handler when requireWorkflowAccess passes", async () => {
    requireWorkflowAccessMock.mockResolvedValueOnce(undefined);
    handlerMock.mockResolvedValueOnce({ ok: true });

    const result = await executeTool({} as never, user, "get_workflow", { workflowId: WORKFLOW_ID });

    expect(result.summary).toBe("summary");
    expect(handlerMock).toHaveBeenCalledTimes(1);
    expect(auditToolCallMock).toHaveBeenCalledTimes(1);
  });
});
