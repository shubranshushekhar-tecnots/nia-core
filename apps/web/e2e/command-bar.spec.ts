import { test, expect, type Page } from '@playwright/test';
import { personas } from './fixtures/personas';

/**
 * CommandBar.tsx (Phase 5 Session 4) — the canvas's floating "Ask or
 * command…" bar. Reuses canvas.spec.ts's navigation/drag helpers rather than
 * re-declaring them; this file owns only command-bar-specific interactions
 * (scope chips, @-pin mention picking, the "/" command hint).
 *
 * Real end-to-end against the seeded canvas-e2e fixtures — same real
 * LLM-gateway + real query dispatch as chat.spec.ts, so timeouts mirror that
 * file's (a real round trip, not a mock).
 */

async function gotoWorkflow(page: Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.getByRole('link', { name: projectName, exact: true }).click();
  await page.getByRole('link', { name: workflowName }).first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/);
}

async function dragPaletteItemOnto(page: Page, label: string, point: { x: number; y: number }) {
  const item = page.getByText(label, { exact: true });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent('dragstart', { dataTransfer });
  const surface = page.getByTestId('canvas-surface');
  await surface.dispatchEvent('dragover', { dataTransfer, clientX: point.x, clientY: point.y });
  await surface.dispatchEvent('drop', { dataTransfer, clientX: point.x, clientY: point.y });
}

test.describe.serial('command bar: scope precedence, chat, / hint, reload persistence', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');
    // Self-healing reset, same convention as canvas.spec.ts's serial block —
    // this file mutates the same shared seeded fixture. Node cleanup uses
    // the on-canvas "✕" buttons directly (never selects a node), so no
    // drawer opens here.
    const deleteButtons = page.getByRole('button', { name: 'Delete node' });
    while ((await deleteButtons.count()) > 0) {
      await deleteButtons.first().click();
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    // Also reset the workflow's chat conversation: resetConversation() only
    // clears client state and starts a new conversation on the next send —
    // it doesn't delete the old one — so a re-run without this would keep
    // accumulating "How many rows..." into the same persisted thread and
    // break the reload-restores-thread assertion's exact-match expectations.
    const newChat = page.getByRole('button', { name: 'New chat' });
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
    }
  });

  test('select -> scope chip -> @-pin -> ask -> citation -> unpin -> deselect -> canvas fallback -> / hint -> reload restores thread', async ({
    page,
  }) => {
    test.setTimeout(150_000);

    // Two source nodes so mongodb-dev is actually wired into the canvas and
    // therefore mentionable (CommandBar's @ popover is workflow-scoped, not
    // the full org connection list).
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragPaletteItemOnto(page, 'Dev sandbox (mongodb)', { x: 450, y: 420 });
    await expect(page.locator('.react-flow__node')).toHaveCount(2);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    const scope = page.getByTestId('command-bar-scope');

    // Before any selection: falls back to "canvas (N connections)".
    await expect(scope).toContainText('canvas (2 connections)');

    // Visual baseline: the bar's resting state (no thread open, no
    // selection/pins — the "canvas (N connections)" fallback chip text).
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page).toHaveScreenshot('command-bar-resting-1440.png', { maxDiffPixels: 200 });

    // Select the mysql node -> scope narrows to that node's own connection,
    // rendered as a single non-removable chip (no × button — it tracks
    // selectedNode directly, per the scope-precedence rule).
    await page.locator('.react-flow__node').first().click();
    await expect(scope.getByTestId('command-bar-scope-chip')).toHaveCount(1);
    await expect(scope.getByTestId('command-bar-scope-chip').first()).toHaveText('@mysql-dev');
    await expect(scope.getByTestId('command-bar-scope-chip').first().locator('button')).toHaveCount(0);

    // @-pin mongodb-dev — pins are additive to the selection, not a
    // replacement (the union rule).
    const input = page.getByTestId('command-bar-input');
    await input.fill('@');
    const dropdown = page.getByTestId('command-bar-mention-dropdown');
    await expect(dropdown).toBeVisible();
    await dropdown.getByText('@mongodb-dev', { exact: true }).click();
    await expect(input).toHaveValue('');
    await expect(scope.getByTestId('command-bar-scope-chip')).toHaveCount(2);
    await expect(scope.getByText('@mongodb-dev')).toBeVisible();
    // The pinned chip (unlike the selection-derived one) is removable.
    const mongoChip = scope.getByTestId('command-bar-scope-chip').filter({ hasText: '@mongodb-dev' });
    const removeBtn = mongoChip.getByRole('button');
    await expect(removeBtn).toBeVisible();

    // Ask a real question -> stage progress -> tokens -> citation chip with
    // a non-empty executedQuery. Same LLM-gateway/query-dispatch round trip
    // as chat.spec.ts's equivalent assertion.
    await input.fill('How many rows are in the orders table?');
    await page.getByTestId('command-bar-send').click();

    await expect(
      page.getByText(/Reading your question|Writing query|Running query|Generating answer/),
    ).toBeVisible({ timeout: 15_000 });

    const citationChip = page.getByRole('button', { name: /mysql-dev.*rows/ });
    await expect(citationChip).toBeVisible({ timeout: 90_000 });
    await citationChip.click();
    const sql = page.getByTestId('command-bar-thread').locator('pre');
    await expect(sql).not.toBeEmpty();

    // Unpin mongodb-dev -> back to the single selection-derived chip.
    await removeBtn.click();
    await expect(scope.getByTestId('command-bar-scope-chip')).toHaveCount(1);
    await expect(scope.getByTestId('command-bar-scope-chip').first()).toHaveText('@mysql-dev');

    // Deselect the node -> no selection, no pins -> falls back to
    // "canvas (N connections)" text, same as before any selection ever
    // happened. NodeDrawer's "Close" button is wired to the exact same
    // onPaneClick/setSelectedNodeId(null) handler as clicking empty canvas
    // (FlowCanvas.tsx: onClose={onPaneClick}) — using it instead of a raw
    // canvas-surface coordinate, which is unreliable: the drawer/rail are
    // absolutely-positioned docked panels covering most of the surface at
    // common viewport widths, so a guessed empty point is fragile.
    await page.getByTestId('node-drawer').getByRole('button', { name: 'Close' }).click();
    await expect(scope).toContainText('canvas (2 connections)');
    await expect(scope.getByTestId('command-bar-scope-chip')).toHaveCount(0);

    // "/" is recognized as a future-command prefix, never sent as chat —
    // Enter is a no-op, so the single citation chip from the real question
    // above stays the only one (no second assistant message got appended).
    await input.fill('/anything');
    await expect(page.getByTestId('command-bar-hint')).toContainText('Commands arrive with Copilot (Phase 7)');
    await expect(page.getByTestId('command-bar-send')).toBeDisabled();
    await input.press('Enter');
    await expect(page.getByRole('button', { name: /mysql-dev.*rows/ })).toHaveCount(1);

    // Reload -> the workflow's conversation (linked via conversations.workflow_id,
    // migration 0015) restores the same thread without re-sending anything.
    await input.fill('');
    await page.reload();
    await expect(page.getByTestId('command-bar-thread')).toBeVisible();
    await expect(page.getByText('How many rows are in the orders table?')).toBeVisible();
  });
});

test.describe('command bar: personal (org-less) workspace', () => {
  test.use({ storageState: personas.canvasC.storageStatePath });

  test('canvasC selects their source node and gets a cited answer through the command bar', async ({ page }) => {
    test.setTimeout(120_000);
    await gotoWorkflow(page, 'Canvas E2E Personal Project', 'Canvas E2E Personal Workflow');

    const deleteButtons = page.getByRole('button', { name: 'Delete node' });
    while ((await deleteButtons.count()) > 0) {
      await deleteButtons.first().click();
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    // Same conversation self-heal as the serial block above — see its
    // comment for why resetConversation() alone (without this) isn't enough
    // across repeated runs.
    const newChat = page.getByRole('button', { name: 'New chat' });
    if (await newChat.isVisible().catch(() => false)) {
      await newChat.click();
    }

    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.locator('.react-flow__node').first().click();
    const scope = page.getByTestId('command-bar-scope');
    await expect(scope.getByTestId('command-bar-scope-chip').first()).toHaveText('@mysql-dev');

    const input = page.getByTestId('command-bar-input');
    await input.fill('How many rows are in the orders table?');
    await page.getByTestId('command-bar-send').click();

    await expect(
      page.getByText(/Reading your question|Writing query|Running query|Generating answer/),
    ).toBeVisible({ timeout: 15_000 });

    const citationChip = page.getByRole('button', { name: /mysql-dev.*rows/ });
    await expect(citationChip).toBeVisible({ timeout: 90_000 });
    await citationChip.click();
    const sql = page.getByTestId('command-bar-thread').locator('pre');
    await expect(sql).not.toBeEmpty();

    // Visual baselines. Deliberately captured here rather than the
    // multi-source serial test above: with two connections in scope
    // (mysql-dev + pinned mongodb-dev) the real answer can cite either or
    // both, and citation count/order isn't stable run to run — masking
    // the prose text isn't enough to stabilize that layout. This test has
    // exactly one connection in scope, so there's exactly one citation
    // chip and one expanded SQL panel every time.
    //
    // The thread container is maxHeight:380/overflowY:auto and grows
    // upward from a bottom anchor, so different real-answer lengths still
    // shift its rendered height (and everything behind it) even with the
    // text masked — pin it to its max height for the screenshot only,
    // then release the override immediately after.
    await page.setViewportSize({ width: 1440, height: 900 });
    const heightPin = await page.addStyleTag({
      content: '[data-testid="command-bar-thread"] { height: 380px !important; }',
    });
    await expect(page).toHaveScreenshot('command-bar-thread-open-1440.png', {
      maxDiffPixels: 400,
      mask: [page.getByTestId('command-bar-message-text'), sql],
    });
    await heightPin.evaluate((el: HTMLElement) => el.remove());

    // ChecksDock's Logs tab populated by this same chat query
    // (activityFeed.ts merges chat + check-run history — no checks have
    // run on this fixture, so this is chat-only rows). Timestamps are
    // real wall-clock and differ run to run, so mask that column. Log
    // text is the user's own (deterministic, fixed) question, not the
    // LLM's answer, so it's stable unmasked.
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    const logsBody = page.getByTestId('checks-dock-logs');
    await expect(logsBody).not.toContainText('Run logs arrive with execution');
    await expect(page).toHaveScreenshot('checks-dock-logs-populated-1440.png', {
      maxDiffPixels: 400,
      mask: [logsBody.locator('div > span:nth-child(1)')],
    });
    await page.getByRole('button', { name: 'Checks', exact: true }).click();

    // canvas.spec.ts's personal-workspace test asserts zero nodes on this
    // same seeded workflow without its own self-heal — clean up after
    // ourselves so that assertion stays true regardless of run order.
    // The thread panel (z-index 35, bottom-center) can overlap the
    // right-docked node-drawer (z-index 20) once it's grown tall with a
    // real answer — dismiss it first so it can't intercept the click.
    await page.getByRole('button', { name: 'Dismiss' }).click();
    // Deletion autosaves via a debounced scheduleSave (FlowCanvas.tsx,
    // AUTOSAVE_DELAY_MS=800ms) — asserting the client-side DOM count alone
    // isn't enough, the test can end and tear down the page before that
    // timer fires, leaving the delete unpersisted server-side. Wait for the
    // actual PUT so the next test/run sees a truly empty graph.
    const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await saved;
  });
});
