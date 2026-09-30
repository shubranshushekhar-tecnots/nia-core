import { describe, it, expect, vi } from "vitest";
import type { WithUser } from "../lib/withUser.js";
import { AppError } from "../lib/appError.js";
import { assertCopilotActionAllowed } from "./chat.js";

/**
 * Subscription Phase 3, Slice 3 — mandatory test: Copilot at 100% refuses.
 * Fake WithUser mirrors grants.test.ts's convention (branch on query text),
 * since assertCopilotActionAllowed's advisory lock + plan-lookup + usage-sum
 * + insert all run inside a single withUser callback.
 */
function createFakeClient(opts: { planName: string; actionLimit: number | null; used: number }) {
  const queries: { text: string; params: readonly unknown[] }[] = [];
  let inserted = false;
  const withUser: WithUser = (async (fn) =>
    fn({
      query: async (text: string, params: readonly unknown[] = []) => {
        queries.push({ text, params });
        if (text.includes("pg_advisory_xact_lock")) {
          return { rows: [] } as never;
        }
        if (text.includes("from public.org_plan op") || text.includes("from public.owner_plan op")) {
          return { rows: [{ plan_name: opts.planName, action_limit: opts.actionLimit }] } as never;
        }
        if (text.includes("from public.usage_events")) {
          return { rows: [{ used: String(opts.used) }] } as never;
        }
        if (text.includes("insert into public.usage_events")) {
          inserted = true;
          return { rows: [] } as never;
        }
        throw new Error(`unexpected query: ${text}`);
      },
    })) as WithUser;

  return { withUser, queries, wasInserted: () => inserted };
}

describe("assertCopilotActionAllowed", () => {
  it("allows and records the action when the workspace is under its Copilot limit", async () => {
    const { withUser, wasInserted } = createFakeClient({ planName: "Pro", actionLimit: 500, used: 10 });

    await expect(assertCopilotActionAllowed(withUser, { orgId: "org-1" }, "job-1")).resolves.toBeUndefined();
    expect(wasInserted()).toBe(true);
  });

  it("refuses with COPILOT_LIMIT_EXCEEDED at 100% of the limit, on every metered plan, and does not record another action", async () => {
    const { withUser, wasInserted } = createFakeClient({ planName: "Free", actionLimit: 50, used: 50 });

    await expect(assertCopilotActionAllowed(withUser, { orgId: "org-1" }, "job-1")).rejects.toMatchObject({
      statusCode: 403,
      code: "COPILOT_LIMIT_EXCEEDED",
      message: "Your Free plan includes 50 Copilot actions a month, and this workspace has already used all of them. Upgrade to keep using Copilot this month.",
    } satisfies Partial<AppError>);
    expect(wasInserted()).toBe(false);
  });

  it("never blocks an unmetered plan (legacy/enterprise: copilot_actions_per_month is null) but still records usage for Console visibility", async () => {
    const { withUser, wasInserted } = createFakeClient({ planName: "Enterprise", actionLimit: null, used: 999999 });

    await expect(assertCopilotActionAllowed(withUser, { ownerId: "user-1" }, "job-1")).resolves.toBeUndefined();
    expect(wasInserted()).toBe(true);
  });
});
