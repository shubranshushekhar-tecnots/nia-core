import { test, expect, type Page } from '@playwright/test';
import { personas } from './fixtures/personas';

/**
 * Navigates via real UI links (project list -> project detail -> workflow),
 * not a hardcoded /app/workflows/:id URL — workflow ids are gen_random_uuid()
 * at seed time, so the id is only knowable by actually clicking through.
 */
async function gotoWorkflow(page: Page, projectName: string, workflowName: string) {
  await page.goto('/app/projects');
  await page.getByRole('link', { name: projectName, exact: true }).click();
  await page.getByRole('link', { name: workflowName }).click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/);
}

/**
 * PaletteDock items are draggable divs using the HTML5 DnD API
 * (dataTransfer.setData), which Playwright's mouse-based dragTo() can't
 * drive reliably — this is the standard Playwright recipe for HTML5 DnD:
 * a real DataTransfer created in-page, dispatched through the same
 * dragstart/dragover/drop sequence the browser would fire natively.
 */
async function dragPaletteItemOnto(page: Page, label: string, point: { x: number; y: number }) {
  await page.getByRole('button', { name: 'Add node' }).click();
  const item = page.getByText(label, { exact: true });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent('dragstart', { dataTransfer });
  const surface = page.getByTestId('canvas-surface');
  await surface.dispatchEvent('dragover', { dataTransfer, clientX: point.x, clientY: point.y });
  await surface.dispatchEvent('drop', { dataTransfer, clientX: point.x, clientY: point.y });
}

/** Connects nodeIndex's source handle to nodeIndex's target handle via a real mouse drag on the actual handle elements (not a guessed pixel offset). */
async function connectNodes(page: Page, fromNodeIndex: number, toNodeIndex: number) {
  const nodes = page.locator('.react-flow__node');
  const sourceHandle = nodes.nth(fromNodeIndex).locator('.react-flow__handle.source');
  const targetHandle = nodes.nth(toNodeIndex).locator('.react-flow__handle.target');
  const sourceBox = (await sourceHandle.boundingBox())!;
  const targetBox = (await targetHandle.boundingBox())!;
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** Drags a node by its card body (avoids the delete button and the edge handles, which sit at the corners/edges). */
async function dragNodeBy(page: Page, nodeIndex: number, dx: number, dy: number) {
  const node = page.locator('.react-flow__node').nth(nodeIndex);
  const box = (await node.boundingBox())!;
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + dx, startY + dy, { steps: 10 });
  await page.mouse.up();
}

/**
 * 'Canvas E2E Workflow' (supabase/seed.sql) is shared, mutable fixture state
 * — every test below that touches it must run one-at-a-time, in this order,
 * hence `.serial` overriding the config's `fullyParallel`. Other describe
 * blocks below use fixtures no other test mutates, so they don't need this.
 */
test.describe.serial('canvas: seeded workflow drag / connect / reload / conflict', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test.beforeEach(async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');
    // Self-healing reset: delete any nodes a previous run left behind, via
    // the real UI (no raw API poke — /workflows/:id/graph requires a Bearer
    // header the browser context can't manufacture out of band).
    const deleteButtons = page.getByRole('button', { name: 'Delete node' });
    while ((await deleteButtons.count()) > 0) {
      await deleteButtons.first().click();
    }
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });

  test('drag 2 sources + 1 transform, connect them, autosave, and reload keeps the graph', async ({ page }) => {
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 250, y: 200 });
    await dragPaletteItemOnto(page, 'Dev sandbox (mongodb)', { x: 250, y: 420 });
    await dragPaletteItemOnto(page, 'Transform', { x: 600, y: 310 });
    await expect(page.locator('.react-flow__node')).toHaveCount(3);

    await connectNodes(page, 0, 2);
    await connectNodes(page, 1, 2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    await expect(page.getByText('Dev sandbox (mysql)')).toBeVisible();
    await expect(page.getByText('Dev sandbox (mongodb)')).toBeVisible();
  });

  test('two tabs on the same workflow: second save gets a 409 conflict, reload recovers', async ({ browser }) => {
    // Seed a starting node via the primary page fixture so both tabs have
    // something real to move.
    const setupCtx = await browser.newContext({ storageState: personas.canvasA.storageStatePath });
    const setupPage = await setupCtx.newPage();
    await gotoWorkflow(setupPage, 'Canvas E2E Project', 'Canvas E2E Workflow');
    await dragPaletteItemOnto(setupPage, 'Dev sandbox (mysql)', { x: 250, y: 200 });
    await dragPaletteItemOnto(setupPage, 'Dev sandbox (mongodb)', { x: 250, y: 420 });
    await expect(setupPage.getByText('Saved')).toBeVisible({ timeout: 5_000 });
    await setupCtx.close();

    const ctxA = await browser.newContext({ storageState: personas.canvasA.storageStatePath });
    const ctxB = await browser.newContext({ storageState: personas.canvasA.storageStatePath });
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await gotoWorkflow(pageA, 'Canvas E2E Project', 'Canvas E2E Workflow');
    await gotoWorkflow(pageB, 'Canvas E2E Project', 'Canvas E2E Workflow');
    await expect(pageA.locator('.react-flow__node')).toHaveCount(2);
    await expect(pageB.locator('.react-flow__node')).toHaveCount(2);

    // A moves a node and wins the save race.
    await dragNodeBy(pageA, 0, 60, 60);
    await expect(pageA.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    // B is still holding the now-stale version; its own move loses the race
    // and must surface a conflict banner, never a silent overwrite.
    await dragNodeBy(pageB, 1, 60, 60);
    const reloadBanner = pageB.getByRole('button', { name: 'Saved elsewhere — reload' });
    await expect(reloadBanner).toBeVisible({ timeout: 5_000 });

    await reloadBanner.click();
    await expect(reloadBanner).not.toBeVisible();
    await expect(pageB.locator('.react-flow__node')).toHaveCount(2);

    await ctxA.close();
    await ctxB.close();
  });
});

test.describe('canvas: cross-org access', () => {
  test('canvasB cannot list or open canvasA\'s workflow', async ({ browser }) => {
    const ctxA = await browser.newContext({ storageState: personas.canvasA.storageStatePath });
    const pageA = await ctxA.newPage();
    await gotoWorkflow(pageA, 'Canvas E2E Project', 'Canvas E2E Workflow');
    const workflowUrl = pageA.url();
    await ctxA.close();

    const ctxB = await browser.newContext({ storageState: personas.canvasB.storageStatePath });
    const pageB = await ctxB.newPage();

    await pageB.goto('/app/projects');
    await expect(pageB.getByRole('link', { name: 'Canvas E2E Project' })).not.toBeVisible();

    await pageB.goto(workflowUrl);
    await expect(pageB).toHaveURL(/\/app$/);

    await ctxB.close();
  });
});

test.describe('canvas: personal workspace', () => {
  test.use({ storageState: personas.canvasC.storageStatePath });

  test('canvasC (no org) can open their personal workflow', async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Personal Project', 'Canvas E2E Personal Workflow');
    await expect(page.getByRole('button', { name: 'Add node' })).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });
});

test.describe('canvas: unknown tool renders without crashing', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  // Pre-seeded workflow_graphs row (supabase/seed.sql), never mutated by any
  // other test — a node whose manifestId isn't in the connector registry.
  test('workflow with an unrecognized manifestId renders a muted node instead of crashing', async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Unknown Tool');
    await expect(page.locator('.react-flow__node')).toHaveCount(1);
    await expect(page.getByText('Unknown tool "not-a-real-connector"')).toBeVisible();
    // Still selectable/deletable — no special-casing in delete/select handlers.
    await expect(page.getByRole('button', { name: 'Delete node' })).toBeVisible();
  });
});
