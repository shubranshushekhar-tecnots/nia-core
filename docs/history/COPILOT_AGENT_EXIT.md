# Copilot Agent — Exit Report

Plan: `docs/plans/copilot-agent.md`. Full writeup: `docs/decisions.md`'s
"Copilot agent" entry.

## What shipped

- Tool registry (`apps/api/src/copilot/registry.ts`, `types.ts`,
  `actingUser.ts`, `executeTool.ts`, `pendingActions.ts`, `audit.ts`,
  `gatewayClient.ts`, `agentLoop.ts`) plus one module per tool under
  `copilot/tools/`.
- v1 tools: 10 read tools (including 3 setup-help explainers), 5 edit
  tools, 2 execute-adjacent tools (`start_run` confirmed, `cancel_run`
  not).
- New route `apps/api/src/routes/copilotAgent.ts`: `POST
  /copilot-agent` (stateless tool-use turn) and `POST
  /copilot-agent/pending-actions/:id/confirm` (the only place a pending
  action is ever confirmed and re-executed).
- Web client `apps/web/src/lib/api/copilotAgentClient.ts` and
  `CommandBar.tsx` wiring for the new agent thread, including a
  workflow-id context stamp on the first message of a conversation.
- Migration `supabase/migrations/0031_copilot_agent.sql` for pending
  actions / agent audit persistence.

## Deviations from the plan, with reasons

- **`change_graph`'s `diff` stayed `z.unknown()`**, not schemas'
  `PlanDiff`, because `PlanDiff`'s `.default()`-bearing fields make its
  Zod input type wider than its output type, which `ToolDefinition`'s
  `inputSchema: z.ZodType<TInput>` constraint can't express. Real
  validation still happens (`applyPlanDiff` calls `PlanDiff.parse`
  itself) — but this made the tool's JSON schema blind to `diff`'s
  shape, which caused two real bugs (false "ghost preview" staleness
  conflicts from an omitted `baseGraphVersion`, and silent no-op applies
  from an omitted `ops`), both found via the required E2E test and fixed
  by rewriting the tool's `description` to spell out the required shape
  in prose. See `docs/decisions.md` for the full detail — this is a
  durable pattern for any future `z.unknown()`-typed tool input.
- **Next.js dev proxy's 30s timeout** was raised to 120s
  (`experimental.proxyTimeout` in `next.config.mjs`) — not in the
  original plan, but real multi-tool-call agent turns routinely take
  45-60s and were getting killed mid-flight in dev. Dev-only.
- **`CommandBar.tsx` workflow-id injection** — not explicitly called out
  in the plan's text, but required to make `change_graph`/`get_workflow`
  unambiguous from the canvas the user is already looking at, mirroring
  how the existing propose/apply flow already threads `workflowId`
  explicitly.

## Tests

- Unit (required, both pre-existing and passing): `registry.test.ts`
  (rejects a tool missing tier/summarizer), `agentLoop.test.ts` (pending
  actions can't be confirmed by the loop or by tool-result content).
- `pnpm --filter @nia/api test`: 41 tests / 9 files, all passing.
- `pnpm --filter @nia/schemas test`: 906 tests / 44 files, all passing.
- `pnpm --filter @nia/guardrails test`: 72 passing + 1 expected fail /
  4 files, as expected.
- E2E `apps/web/e2e/copilot.spec.ts` (full suite, including the new
  required flow): 7/7 passing, no regressions to the two pre-existing
  propose/apply tests.
- `pnpm -r typecheck`: all 9 workspace packages clean.

## Not committed

Per the plan's instruction, no commit was made. `git status
--porcelain` at close is in the final chat response.
