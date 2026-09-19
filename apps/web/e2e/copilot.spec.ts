import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { personas } from './fixtures/personas';

/**
 * The Playwright test process is plain node — it never runs through
 * Next.js's own env loading, so apps/web/.env.local's NEXT_PUBLIC_* vars
 * (which `next dev`'s webServer process reads for itself) aren't in this
 * process's `process.env` unless the invoking shell happened to export
 * them. Load the file directly, same values the running dev server itself
 * uses, without pulling in a dotenv dependency this repo doesn't have.
 */
function loadWebEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || !/^[A-Z0-9_]+$/.test(trimmed.slice(0, eq))) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadWebEnv();

/**
 * Phase 7 Session 3 — Copilot's plan-propose -> ghost preview -> Apply loop,
 * end to end against a real worker LLM call (same "real round trip, generous
 * timeouts" convention as chat.spec.ts/command-bar.spec.ts, not mocked).
 *
 * Runs as canvasC (org-less personal workspace) specifically because of
 * audit_log's RLS policy (0007_connectors.sql's audit_log_select_admins_or_self):
 * org-scoped rows are only client-readable by an org *admin*, and canvasA
 * (this suite's only org persona with real seeded connections) is a plain
 * `member`, not admin/owner, of canvas-e2e — it cannot read its own org's
 * audit_log directly. canvasC's rows are org_id IS NULL, owner_id = self,
 * which the same policy's `or (org_id is null and owner_id = auth.uid())`
 * branch lets its own owner self-read with no admin-role juggling.
 */

async function gotoWorkflow(page: Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.getByRole('link', { name: projectName, exact: true }).click();
  await page.getByRole('link', { name: workflowName }).first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/);
}

/**
 * apps/web's Supabase browser client (lib/supabase/client.ts) persists the
 * session as a single `sb-<ref>-auth-token` cookie (base64-prefixed JSON),
 * not localStorage — confirmed against this suite's own saved storageState
 * fixtures (playwright/.auth/*.json only carry a cookies array, no origins/
 * localStorage entries). Decode it and hand the access/refresh token pair
 * to a plain node-side @supabase/supabase-js client via setSession() so the
 * query below runs through the exact same RLS the browser session would —
 * this project has no service-role key available to apps/web by design
 * (CLAUDE.md), so this is the only faithful way to assert a row exists.
 */
async function readOwnAuditRows(page: Page, action: string) {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => /^sb-.+-auth-token$/.test(c.name));
  if (!authCookie) throw new Error('No sb-*-auth-token cookie on this context — is the persona logged in?');
  const raw = authCookie.value.startsWith('base64-') ? authCookie.value.slice('base64-'.length) : authCookie.value;
  const session = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as {
    access_token: string;
    refresh_token: string;
  };

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54321';
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY not set in the test process env.');

  const supabase = createClient(supabaseUrl, anonKey);
  const { error: sessionError } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (sessionError) throw sessionError;

  const { data, error } = await supabase
    .from('audit_log')
    .select('action, detail, created_at, actor, org_id, owner_id')
    .eq('action', action)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return data ?? [];
}

/** JWT payload's `sub` claim (the auth.uid() the RPC's `actor` column should match). */
function decodeUserId(accessToken: string): string {
  const payloadSegment = accessToken.split('.')[1];
  if (!payloadSegment) throw new Error('Access token is not a well-formed JWT (missing payload segment).');
  const payload = JSON.parse(Buffer.from(payloadSegment, 'base64').toString('utf8')) as { sub: string };
  return payload.sub;
}

/**
 * Just the bearer token half of readOwnAuditRows' cookie decode, for tests
 * that need to call apps/api directly (bypassing the UI) rather than query
 * Supabase. Deliberately not shared with readOwnAuditRows — that function
 * is exercised by the passing happy-path test above and is left untouched.
 */
async function getAccessToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => /^sb-.+-auth-token$/.test(c.name));
  if (!authCookie) throw new Error('No sb-*-auth-token cookie on this context — is the persona logged in?');
  const raw = authCookie.value.startsWith('base64-') ? authCookie.value.slice('base64-'.length) : authCookie.value;
  const session = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as { access_token: string };
  return session.access_token;
}

test.describe('copilot: propose -> ghost preview -> apply', () => {
  test.use({ storageState: personas.canvasC.storageStatePath });

  test('typed request proposes a plan, ghost renders, Apply persists it, and it survives reload', async ({ page }) => {
    test.setTimeout(150_000);

    await gotoWorkflow(page, 'Canvas E2E Personal Project', 'Canvas E2E Personal Workflow');

    // Self-healing reset — same convention as canvas.spec.ts/command-bar.spec.ts's
    // personal-workspace tests, this file mutates the same shared fixture.
    // Delete no longer lives on the card itself (GraphFlowNode.tsx: moved to
    // the floating NodeConfigPanel's header ribbon, reachable once a node is
    // selected) — select each leftover node before deleting it.
    let deletedAny = false;
    while ((await page.locator('.react-flow__node').count()) > 0) {
      deletedAny = true;
      await page.locator('.react-flow__node').first().click();
      await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    if (deletedAny) {
      // Same rationale as canvas.spec.ts's self-heal hook: the last delete
      // click above starts FlowCanvas's 800ms debounced autosave. If this
      // block returned before that PUT fires, it can land later and bump
      // workflow_graphs.version out from under the propose call below,
      // producing a spurious PLAN_STALE 409 on Apply. Wait for the real
      // save (and its "Saved" text to clear) before proceeding.
      await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText('Saved')).not.toBeVisible({ timeout: 3_000 });
    }

    const newChat = page.getByRole('button', { name: 'New chat' });
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
    }

    // Single add-only ask against canvasC's one seeded connection (mysql) —
    // deliberately the smallest possible plan (one new source node, no
    // aggregate/groupBy, so no cardinality probe and nothing to clarify
    // about) to keep the real LLM call's outcome reliably "ok". Table name
    // must be a real one in the dev-mysql sandbox schema (confirmed live:
    // employees, plan_eval_headroom, plan_eval_wide, sandbox_items) — an
    // unknown table name makes the LLM correctly return "clarify" instead.
    const input = page.getByTestId('command-bar-input');
    await input.fill('/Add a source node reading the sandbox_items table from my mysql connection.');
    await page.getByTestId('command-bar-send').click();

    await expect(page.getByTestId('command-bar-plan-pending')).toBeVisible({ timeout: 15_000 });

    const planBanner = page.getByTestId('plan-banner');
    await expect(planBanner).toBeVisible({ timeout: 90_000 });
    // Ghost nodes mount via the same React Flow node wrapper as real nodes,
    // which briefly holds new nodes at visibility:hidden until their
    // dimensions are measured (ResizeObserver) — plus FlowCanvas.tsx's own
    // fitView-on-new-ghost-plan effect (400ms pan/zoom). Generous timeout
    // to ride out both rather than a flaky default-5s assertion.
    await expect(page.getByText('Proposed', { exact: true })).toBeVisible({ timeout: 10_000 });
    // Ghost node(s) render through GraphFlowNode like any other node — just
    // with a "Proposed" badge and no delete button (ghostMapping.ts /
    // GraphFlowNode.tsx) — so a real react-flow node count proves the ghost
    // actually mounted on the canvas, not just that the banner text exists.
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0);

    // Captured before Apply — the banner (and ghostPlan.summary with it)
    // is gone once Apply succeeds, so this is the only chance to read it.
    const planSummaryText = await planBanner.locator('span').first().textContent();

    await page.getByTestId('plan-banner-apply').click();
    await expect(planBanner).not.toBeVisible({ timeout: 15_000 });

    // Applied nodes are real nodes now — "Proposed" badge gone. Delete no
    // longer lives on the card itself (GraphFlowNode.tsx: moved to the
    // floating NodeConfigPanel's header ribbon, reachable once a node is
    // selected) — select the applied node to prove it's a normal,
    // selectable/deletable node like any other.
    await expect(page.getByText('Proposed', { exact: true })).not.toBeVisible();
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' })).toBeVisible();

    const workflowId = page.url().match(/\/app\/workflows\/([0-9a-f-]{36})/)?.[1];
    expect(workflowId).toBeTruthy();

    // Proves the audit trail Apply is supposed to be load-bearing for
    // (CLAUDE.md: "the audit log is load-bearing... the only record of who
    // installed/deleted/minted what") actually landed, via the real
    // migration 0019 RPC (log_plan_applied -> action 'copilot_plan.applied').
    const rows = await readOwnAuditRows(page, 'copilot_plan.applied');
    const matching = rows.find((r) => (r.detail as { workflowId?: string })?.workflowId === workflowId);
    expect(matching, `expected a copilot_plan.applied audit_log row for workflow ${workflowId}`).toBeTruthy();
    // Full ledgered shape (0019's log_plan_applied RPC), not just workflowId.
    const userId = decodeUserId(await getAccessToken(page));
    const detail = matching!.detail as {
      planSummary?: string;
      prompt?: string | null;
      appliedNodeIds?: string[];
    };
    expect(matching!.actor).toBe(userId);
    // canvasC is org-less (personal workspace): org_id null, owner_id self —
    // mirrors 0019's own resolution off workflows.org_id/owner_id.
    expect(matching!.org_id).toBeNull();
    expect(matching!.owner_id).toBe(userId);
    expect(detail.planSummary).toBe(planSummaryText);
    expect(detail.appliedNodeIds?.length).toBeGreaterThan(0);
    // FlowCanvas.tsx's handleApplyPlan calls applyPlan(workflow.id, { plan })
    // with no prompt field — the original command-bar text is never plumbed
    // through Apply. Verified live (this assertion's first run failed with
    // received "" against an assumed null): apps/api's applyPlanBodySchema
    // has `prompt: z.string().optional().default("")`, so a missing prompt
    // becomes "" before copilotApply.ts's `input.prompt ?? null` ever runs
    // (?? only catches null/undefined, not "") — the persisted value is
    // genuinely "", not null. Documented, not fixed here (standing rule:
    // don't fix unrelated issues).
    expect(detail.prompt).toBe('');

    // The real proof Apply went through putWorkflowGraph's persisted write
    // path, not just client state: reload and confirm the node is still
    // there, still non-ghost.
    await page.reload();
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0);
    await expect(page.getByText('Proposed', { exact: true })).not.toBeVisible();
    // Reload clears client selection state — re-select before checking.
    await page.locator('.react-flow__node').first().click();
    await expect(page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' })).toBeVisible();

    // Clean up after ourselves (same convention as command-bar.spec.ts's
    // personal-workspace test) — wait for the delete's debounced autosave
    // PUT so the next run starts from a truly empty graph.
    const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    while ((await page.locator('.react-flow__node').count()) > 0) {
      await page.locator('.react-flow__node').first().click();
      await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
    }
    await saved;
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });

  test('a genuine external graph change between propose and Apply is refused with 409, and the ghost preview is preserved', async ({
    page,
  }) => {
    test.setTimeout(90_000);

    await gotoWorkflow(page, 'Canvas E2E Personal Project', 'Canvas E2E Personal Workflow');
    const workflowId = page.url().match(/\/app\/workflows\/([0-9a-f-]{36})/)?.[1];
    expect(workflowId).toBeTruthy();

    // Self-healing reset — same convention as the test above.
    let deletedAny = false;
    while ((await page.locator('.react-flow__node').count()) > 0) {
      deletedAny = true;
      await page.locator('.react-flow__node').first().click();
      await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    if (deletedAny) {
      await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByText('Saved')).not.toBeVisible({ timeout: 3_000 });
    }

    const newChat = page.getByRole('button', { name: 'New chat' });
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
    }

    const input = page.getByTestId('command-bar-input');
    await input.fill('/Add a source node reading the sandbox_items table from my mysql connection.');
    await page.getByTestId('command-bar-send').click();
    await expect(page.getByTestId('command-bar-plan-pending')).toBeVisible({ timeout: 15_000 });

    const planBanner = page.getByTestId('plan-banner');
    await expect(planBanner).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText('Proposed', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0);

    // Simulate a genuine external write landing between propose and Apply —
    // a real second session/tab saving to the same workflow, not the
    // self-heal-debounce race the wait-for-save guard above (and in the
    // test before this one) was built to absorb. Goes straight at apps/api's
    // PUT /:id/graph with a bearer token pulled from this same persona's own
    // session cookie — a path the wait-for-save guard cannot observe, since
    // that guard only watches this page's own saveState/"Saved" text.
    const accessToken = await getAccessToken(page);
    const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4001';
    const authHeaders = { Authorization: `Bearer ${accessToken}` };

    const currentRes = await page.request.get(`${apiUrl}/workflows/${workflowId}/graph`, { headers: authHeaders });
    expect(currentRes.ok(), `GET graph should succeed: ${currentRes.status()} ${await currentRes.text()}`).toBeTruthy();
    const current = await currentRes.json();

    // A real content change, not a resave of identical content —
    // workflow_graphs_bump_version (0012_workflow_graphs.sql) only bumps
    // version when the graph actually changes. A bare transform node with
    // no connectionId/manifestId is a valid GraphNode (graph.ts) and is all
    // this race needs — its purpose is to move the version, not to be a
    // sensible node.
    const racedGraph = {
      ...current.graph,
      nodes: [...current.graph.nodes, { id: 'race-node', type: 'transform', position: { x: 0, y: 0 }, config: {} }],
    };
    const raceRes = await page.request.put(`${apiUrl}/workflows/${workflowId}/graph`, {
      headers: authHeaders,
      data: { graph: racedGraph, expectedVersion: current.version },
    });
    expect(raceRes.ok(), `external race PUT should succeed: ${raceRes.status()} ${await raceRes.text()}`).toBeTruthy();

    // Apply now targets a stale baseGraphVersion. copilotApply.ts's own
    // version check (services/copilotApply.ts) must refuse it with 409
    // PLAN_STALE — not silently re-base or apply on top of the wrong graph.
    await page.getByTestId('plan-banner-apply').click();
    await expect(planBanner.getByText('This workflow changed since the plan was proposed.')).toBeVisible({
      timeout: 15_000,
    });
    // Ghost preserved, not silently discarded (FlowCanvas.tsx: clearGhost()
    // only runs on Apply success) — same react-flow-node-count proof the
    // happy-path test above uses to confirm a ghost is actually mounted.
    await expect(planBanner).toBeVisible();
    await expect(page.getByText('Proposed', { exact: true })).toBeVisible();
    await expect(page.locator('.react-flow__node')).not.toHaveCount(0);

    // Confirm nothing from the plan landed server-side — only the raced
    // node is on the real graph (a readback, not client state).
    const afterRes = await page.request.get(`${apiUrl}/workflows/${workflowId}/graph`, { headers: authHeaders });
    const after = await afterRes.json();
    expect(after.graph.nodes.map((n: { id: string }) => n.id)).toEqual(['race-node']);

    // Cleanup: discard the ghost, reload to pick up the raced node fresh
    // from the server, then delete it via the UI (same convention as the
    // test above) so the shared fixture is empty again for the next run.
    await page.getByTestId('plan-banner-discard').click();
    await expect(planBanner).not.toBeVisible();
    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(1);

    const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await page.locator('.react-flow__node').first().click();
    await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
    await saved;
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });
});
