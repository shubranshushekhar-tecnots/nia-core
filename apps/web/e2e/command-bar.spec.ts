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

// Same fix as visual.spec.ts (Phase 5 Session 5 exit review): `next dev`'s
// build-activity indicator (<nextjs-portal>, bottom-left) pops in/out at
// screenshot time independent of real page content — hide it before any
// toHaveScreenshot call in this file.
async function hideNextDevIndicator(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

test.describe.serial('command bar: scope precedence, chat, / hint, reload persistence', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');
    // Self-healing reset, same convention as canvas.spec.ts's serial block —
    // this file mutates the same shared seeded fixture. Delete no longer
    // lives on the card itself (GraphFlowNode.tsx: moved to the floating
    // NodeConfigPanel's header ribbon, reachable once a node is selected) —
    // select each leftover node before deleting it.
    while ((await page.locator('.react-flow__node').count()) > 0) {
      await page.locator('.react-flow__node').first().click();
      await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
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
    await hideNextDevIndicator(page);
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

    // "/" now dispatches to Copilot's plan-propose flow (Phase 7 Session 3)
    // instead of being blocked — the hint reflects that, and the send button
    // is enabled (unlike the old "Commands arrive with Copilot" placeholder
    // behavior this test used to assert). Real plan-propose round trips are
    // covered by copilot.spec.ts; here we only assert the hint/enablement
    // and back out without sending, so the single citation chip from the
    // real question above stays the only one (no second assistant message
    // got appended).
    await input.fill('/anything');
    await expect(page.getByTestId('command-bar-hint')).toContainText('Copilot will propose a plan');
    await expect(page.getByTestId('command-bar-send')).toBeEnabled();

    // "/" suggestion menu (this session) — appears while still composing
    // the leading command token, offers example prompts. Picking one only
    // fills the input (doesn't auto-send), so the user can edit specifics
    // before hitting Send. Typing past the token (a space) closes it.
    await input.fill('/');
    const slashMenu = page.getByTestId('command-bar-slash-menu');
    await expect(slashMenu).toBeVisible();
    await expect(slashMenu.getByRole('button')).toHaveCount(6);
    // dispatchEvent (not .click()) — same technique dragPaletteItemOnto uses
    // above — bypasses Playwright's viewport-actionability gate, which the
    // unrelated concurrent CanvasHeader/CanvasIconRail WIP layout currently
    // trips (extra header chrome leaves too little room above the bar for
    // this upward-opening dropdown).
    await slashMenu.getByRole('button').first().dispatchEvent('mousedown');
    await expect(input).toHaveValue(/^\/Add a source node reading a table/);
    await expect(slashMenu).not.toBeVisible();

    await input.fill('');
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

    // Delete no longer lives on the card itself (GraphFlowNode.tsx: moved
    // to the floating NodeConfigPanel's header ribbon, reachable once a
    // node is selected) — select each leftover node before deleting it.
    while ((await page.locator('.react-flow__node').count()) > 0) {
      await page.locator('.react-flow__node').first().click();
      await page.getByTestId('node-drawer').getByRole('button', { name: 'Delete node' }).click();
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
    await hideNextDevIndicator(page);
    const heightPin = await page.addStyleTag({
      content: '[data-testid="command-bar-thread"] { height: 380px !important; }',
    });
    // Masking alone isn't enough here: Playwright's mask still sizes the
    // covering rectangle from the masked element's live bounding box, only
    // its pixel content is hidden, and both masked elements (the answer
    // prose, the SQL <pre>) are content-hugging width — their real
    // rendered width varies with live LLM/SQL output length, which shifts
    // the mask edges run-to-run even though nothing regressed. Confirmed
    // by direct pixel inspection and repeated reruns against a fixed
    // baseline, which kept failing at different maxDiffPixels thresholds
    // (900, 1800) with different diff counts each time — a bigger number
    // never converges because the variance is unbounded, not a fixed
    // fudge factor. Real fix: pin both masked elements to a fixed width
    // for the screenshot only (same technique as the height pin above),
    // so the mask geometry is deterministic regardless of content length.
    const widthPin = await page.addStyleTag({
      content:
        '[data-testid="command-bar-message-text"] { width: 480px !important; } ' +
        '[data-testid="command-bar-thread"] pre { width: 480px !important; }',
    });
    // maxDiffPixels headroom above the other two visual baselines in this
    // file (400): even with mask geometry pinned deterministic (above),
    // repeated reruns against a fixed baseline showed a second, unrelated,
    // *bounded* source of diff — a consistent ~612px delta traced to the
    // canvas's react-flow node/selection-outline rendering, not live
    // content. Unlike the mask-width issue this is a fixed-size jitter
    // class, so a fixed headroom is an appropriate (not unbounded) fix.
    await expect(page).toHaveScreenshot('command-bar-thread-open-1440.png', {
      maxDiffPixels: 900,
      mask: [page.getByTestId('command-bar-message-text'), sql],
    });
    await widthPin.evaluate((el: HTMLElement) => el.remove());
    await heightPin.evaluate((el: HTMLElement) => el.remove());

    // ChecksDock's Logs tab populated by this same chat query
    // (activityFeed.ts merges chat + check-run history — no checks have
    // run on this fixture, so this is chat-only rows). Timestamps are
    // real wall-clock and differ run to run, so mask that column. Log
    // text is the user's own (deterministic, fixed) question, not the
    // LLM's answer, so it's stable unmasked. The thread panel's SQL <pre>
    // is still visible (bleeding through the dock's translucency) behind
    // this dock even though this screenshot isn't testing it — mask it
    // too, same locator as the thread-open baseline above: its glyphs
    // were producing a small but real diff from sub-pixel anti-aliasing
    // differences under the translucent overlay (Phase 5 Session 5 exit
    // review), unrelated to anything this assertion actually checks.
    await page.getByRole('button', { name: 'Logs', exact: true }).click();
    const logsBody = page.getByTestId('checks-dock-logs');
    await expect(logsBody).not.toContainText('Run logs arrive with execution');
    await hideNextDevIndicator(page);
    await expect(page).toHaveScreenshot('checks-dock-logs-populated-1440.png', {
      maxDiffPixels: 400,
      mask: [logsBody.locator('div > span:nth-child(1)'), sql],
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
