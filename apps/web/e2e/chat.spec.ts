import { test, expect } from '@playwright/test';
import { personas } from './fixtures/personas';

test.describe('/app/chat route group redirect boundary', () => {
  for (const path of ['/app/chat', '/app/chat/00000000-0000-0000-0000-000000000000']) {
    test(`unauthenticated user hitting ${path} is redirected to /login with ?next=`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path).replace(/[/]/g, '%2F')}`));
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    });
  }
});

test.describe('authenticated chat', () => {
  test.use({ storageState: personas.demo.storageStatePath });

  // Real end-to-end: demo@nia.dev's real @mysql-dev connection (seeded by
  // dev-bootstrap.ts) through the real worker/LLM-gateway pipeline. No
  // data-testids exist on the citation chip/SQL in ChatClient.tsx (the old
  // skipped version of this test referenced aspirational ones) — selecting
  // by role/text against the actual markup instead. Generous timeouts
  // because this crosses a real LLM call + real query dispatch, not a mock.
  test('send -> stage progress -> tokens -> citation chip expands with non-empty executedQuery', async ({ page }) => {
    // Playwright's default 30s test timeout is shorter than the 90s citation-chip
    // wait below (a real LLM call + real query dispatch, not a mock) — bump it so
    // the outer test timeout doesn't cut this off before the inner expect() can.
    test.setTimeout(120_000);
    await page.goto('/app/chat');

    await page.getByRole('button', { name: /mysql-dev/ }).click();
    await page.getByPlaceholder('Ask about your data…').fill('How many rows are in the orders table?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/Reading your question|Writing query|Running query|Generating answer/)).toBeVisible({
      timeout: 15_000,
    });

    const citationChip = page.getByRole('button', { name: /mysql-dev.*rows/ });
    await expect(citationChip).toBeVisible({ timeout: 90_000 });
    await citationChip.click();

    const sql = page.locator('pre');
    await expect(sql).not.toBeEmpty();
  });

  // Not covered: a deterministic 'refused' trigger. The UI only ever sends a
  // single connectionId (ChatClient.tsx's handleSend: `connectionIds:
  // [selectedConnectionId]`), so the capacity-limit refusal path
  // (runChatQuery.ts, >1 source) is unreachable from real UI interaction.
  // The other refusal kind (unsupported-operation) is a judgment call made
  // by the real LLM gateway on the message content — not something this
  // codebase exposes a deterministic trigger for, so asserting on it would
  // be asserting on live model behavior rather than app behavior. Leaving
  // this skipped with this specific, current reason (not the old blanket
  // "no session" one).
  test.skip('refused case renders the refused state', async () => {});

  test('cross-org user sees no foreign conversations in history', async ({ browser }) => {
    const marker = `E2E cross-org check ${Date.now()}`;

    const demoContext = await browser.newContext({ storageState: personas.demo.storageStatePath });
    const demoPage = await demoContext.newPage();
    await demoPage.goto('/app/chat');
    await demoPage.getByRole('button', { name: /mysql-dev/ }).click();
    await demoPage.getByPlaceholder('Ask about your data…').fill(marker);
    await demoPage.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(demoPage).toHaveURL(/\/app\/chat\/[0-9a-f-]{36}/, { timeout: 15_000 });
    await demoContext.close();

    const otherOrgContext = await browser.newContext({ storageState: personas.canvasB.storageStatePath });
    const otherOrgPage = await otherOrgContext.newPage();
    await otherOrgPage.goto('/app/chat');
    await expect(otherOrgPage.getByText(marker)).not.toBeVisible();
    await otherOrgContext.close();
  });
});

// canvas-e2e-c@nia.dev is org-less (personal/individual workspace, see
// supabase/seed.sql's "Canvas E2E fixtures" block) — its @mysql-dev
// connection is seeded by dev-bootstrap.ts with owner_id set instead of
// org_id. This proves the chat pipeline's WorkspaceScope-based channel/
// ownership plumbing (apps/api/src/lib/chatChannel.ts,
// apps/worker/src/lib/chat/publish.ts, routes/chat.ts's sameScope check)
// works end-to-end for a real personal-workspace user, not just orgs.
test.describe('authenticated chat — personal (org-less) workspace', () => {
  test.use({ storageState: personas.canvasC.storageStatePath });

  test('user with no org sends personal-scope chat -> full stream -> citation with non-empty executedQuery', async ({
    page,
  }) => {
    // Same reasoning as the org-path test above: real LLM call + real query
    // dispatch can exceed Playwright's default 30s test timeout.
    test.setTimeout(120_000);
    await page.goto('/app/chat');

    // Deliberately no connection-toggle click here: canvas-e2e-c has
    // exactly one connection (@mysql-dev), and ChatClient.tsx auto-selects
    // the sole connection on mount (`connections.length === 1 ? ... :
    // null`). Clicking it would actually *deselect* it (pickConnection
    // toggles), unlike the org-scoped demo test above which has 2
    // connections and genuinely needs the click.
    await expect(page.getByText(/In scope:.*mysql-dev/)).toBeVisible();
    await page.getByPlaceholder('Ask about your data…').fill('How many rows are in the orders table?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.getByText(/Reading your question|Writing query|Running query|Generating answer/)).toBeVisible({
      timeout: 15_000,
    });

    const citationChip = page.getByRole('button', { name: /mysql-dev.*rows/ });
    await expect(citationChip).toBeVisible({ timeout: 90_000 });
    await citationChip.click();

    const sql = page.locator('pre');
    await expect(sql).not.toBeEmpty();
  });

  // Negative counterpart to the above: a different actor (canvas-e2e-a, a
  // different org entirely) must never be able to subscribe to user C's
  // personal-scope job stream, even with a guessed/leaked real jobId.
  // routes/chat.ts's GET /chat/stream does the sameScope(jobData.scope,
  // requestingActor.scope) check BEFORE ever calling subscribeWithReplay —
  // this hits that same-origin backend route directly (bypassing the UI)
  // with an authenticated APIRequestContext to assert the 403 happens at
  // the HTTP layer, not just "the UI doesn't show it".
  test("a different user's session gets 403 on GET /chat/stream for user C's own jobId", async ({ page }) => {
    await page.goto('/app/chat');
    // Same auto-select reasoning as the test above — no click needed/wanted.
    await expect(page.getByText(/In scope:.*mysql-dev/)).toBeVisible();

    const [postResponse] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/backend/chat') && res.request().method() === 'POST'),
      (async () => {
        await page.getByPlaceholder('Ask about your data…').fill('How many rows are in the orders table?');
        await page.getByRole('button', { name: 'Send', exact: true }).click();
      })(),
    ]);
    const { jobId } = (await postResponse.json()) as { jobId: string };
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);

    const foreignContext = await page.context().browser()!.newContext({
      storageState: personas.canvasA.storageStatePath,
    });
    const foreignApi = foreignContext.request;
    const streamResponse = await foreignApi.get(`/api/backend/chat/stream?jobId=${jobId}`);
    expect(streamResponse.status()).toBe(403);
    await foreignContext.close();
  });
});
