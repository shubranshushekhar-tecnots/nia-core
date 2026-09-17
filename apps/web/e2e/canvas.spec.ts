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
  // .first(): the sidebar's project tree can already be expanded around this
  // project (persisted openProject UI state) at the same time the project
  // detail page's own workflow list renders it too — both links share the
  // same href, so either is a valid click target.
  await page.getByRole('link', { name: workflowName }).first().click();
  await expect(page).toHaveURL(/\/app\/workflows\/[0-9a-f-]{36}/);
}

/**
 * NodesRail items are draggable divs using the HTML5 DnD API
 * (dataTransfer.setData), which Playwright's mouse-based dragTo() can't
 * drive reliably — this is the standard Playwright recipe for HTML5 DnD:
 * a real DataTransfer created in-page, dispatched through the same
 * dragstart/dragover/drop sequence the browser would fire natively. The
 * rail (NodesRail.tsx) is persistent/always-visible now (Task 1 replaced
 * the old PaletteDock modal), so there's no "Add node" button to open first.
 */
async function dragPaletteItemOnto(page: Page, label: string, point: { x: number; y: number }) {
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
 * Same drag as dragPaletteItemOnto, but scoped to a specific rail section
 * (Sources/Destinations) — needed for connectors like supabase that have
 * both etl_source and etl_sink capabilities and so render the same label
 * ("Dev sandbox (supabase)") once per section (NodesRail.tsx's buildEntries),
 * which a bare page.getByText(label) would hit as a strict-mode violation.
 */
async function dragRailSectionItemOnto(page: Page, section: string, label: string, point: { x: number; y: number }) {
  const rail = page.getByTestId('nodes-rail');
  const sectionContainer = rail.getByText(section, { exact: true }).locator('..');
  const item = sectionContainer.getByText(label, { exact: true });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent('dragstart', { dataTransfer });
  const surface = page.getByTestId('canvas-surface');
  await surface.dispatchEvent('dragover', { dataTransfer, clientX: point.x, clientY: point.y });
  await surface.dispatchEvent('drop', { dataTransfer, clientX: point.x, clientY: point.y });
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
    // x >= 450 keeps every dropped node's body/handles clear of NodesRail's
    // page-space footprint (left:16/width:252 relative to the canvas
    // wrapper, which itself starts ~240px in — i.e. rail spans roughly
    // page-x 256-508). A drop at x=250 puts the node's right-edge source
    // handle at ~x444, still under the rail's z-index:20 overlay, so real
    // mouse-driven connectNodes()/dragNodeBy() clicks land on the rail
    // instead of the node/handle.
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragPaletteItemOnto(page, 'Dev sandbox (mongodb)', { x: 450, y: 420 });
    await dragPaletteItemOnto(page, 'Transform', { x: 800, y: 310 });
    await expect(page.locator('.react-flow__node')).toHaveCount(3);

    await connectNodes(page, 0, 2);
    await connectNodes(page, 1, 2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);

    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.reload();
    await expect(page.locator('.react-flow__node')).toHaveCount(3);
    await expect(page.locator('.react-flow__edge')).toHaveCount(2);
    // Scoped to canvas nodes, not the page as a whole — the persistent
    // NodesRail (Task 1) also renders a "Dev sandbox (mysql/mongodb)" entry,
    // which would otherwise make these a strict-mode-violating duplicate match.
    await expect(page.locator('.react-flow__node').getByText('Dev sandbox (mysql)')).toBeVisible();
    await expect(page.locator('.react-flow__node').getByText('Dev sandbox (mongodb)')).toBeVisible();
  });

  test('selecting a source node opens the drawer with an enabled read verb (no connector declares a write op yet, so "Locked" can\'t be exercised here)', async ({ page }) => {
    // 1440px viewport for this test only (via setViewportSize, not a
    // describe-level test.use, so it doesn't shift drop coordinates in the
    // other tests in this .serial block) — this is also the shot used as the
    // visual-diff baseline for the NodesRail + NodeDrawer pairing (Task 4).
    await page.setViewportSize({ width: 1440, height: 900 });
    // Dropped clear of the 252px-wide NodesRail (Task 1) — a node dropped
    // under the rail is still there, but a plain .click() on it (unlike the
    // mouse-based drags the other tests use) fails Playwright's actionability
    // check because the rail div intercepts the pointer event.
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await page.locator('.react-flow__node').first().click();
    const drawer = page.getByTestId('node-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Verb')).toBeVisible();
    const readRadio = drawer.getByRole('radio', { name: 'read' });
    await expect(readRadio).toBeChecked();
    await expect(readRadio).toBeEnabled();
    // maxDiffPixels tolerates a few pixels of sub-pixel jitter from the
    // canvas's SVG node/edge rendering (react-flow) between runs — not a
    // real regression signal at this magnitude. ChecksDock is masked: its
    // pill text reflects whatever check-run row is currently persisted for
    // this shared workflow fixture, which legitimately differs across
    // separate full-suite invocations (e.g. after the checks-dock test
    // below has run at least once) — this shot's actual subject is the
    // NodesRail + NodeDrawer pairing, not the dock's state.
    await expect(page).toHaveScreenshot('canvas-rail-drawer-1440.png', {
      maxDiffPixels: 50,
      mask: [page.getByTestId('checks-dock')],
    });
  });

  test('transform drawer: build a filter step, autosave, reload keeps it, and shows the pushdown summary', async ({ page }) => {
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragPaletteItemOnto(page, 'Transform', { x: 800, y: 310 });
    await connectNodes(page, 0, 1);

    await page.locator('.react-flow__node').nth(1).click();
    const drawer = page.getByTestId('node-drawer');
    await drawer.getByRole('button', { name: '+ Filter' }).click();
    // A new filter step starts with zero conditions (no <select> rendered
    // yet) — "+ Condition" adds the first row.
    await drawer.getByRole('button', { name: '+ Condition' }).click();
    // Field suggestions come from the upstream connection's schema (GET
    // /connections/:id/schema), fetched async — FieldSelect renders a plain
    // <input placeholder="field name"> until that resolves, so .nth(0)
    // isn't reliably the field <select> until this input is gone.
    await expect(drawer.getByPlaceholder('field name')).toHaveCount(0, { timeout: 15_000 });
    const fieldSelect = drawer.locator('select').nth(0);
    await fieldSelect.selectOption('salary');
    const operatorSelect = drawer.locator('select').nth(1);
    await operatorSelect.selectOption('gt');
    // Autosave is debounced 800ms off a single shared timer
    // (FlowCanvas.tsx's AUTOSAVE_DELAY_MS) — the earlier "+ Filter"/
    // "+ Condition" clicks may already have fired their own intermediate
    // (incomplete) save while we were waiting for the field-select fetch
    // above, so a bare `getByText('Saved')` check right after `fill()` can
    // pass on a stale flash from that earlier save instead of the one
    // carrying this filled-in condition. Wait for the actual graph PUT
    // triggered by this edit before trusting "Saved" / reloading.
    const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await drawer.getByPlaceholder('value').fill('50000');

    await expect(drawer.getByText(/Pushed down: \d+ · In-stream: \d+/)).toBeVisible();
    await saved;
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 2_000 });

    await page.reload();
    await page.locator('.react-flow__node').nth(1).click();
    const reopened = page.getByTestId('node-drawer');
    // Same field-select async-schema race as above — wait for the plain
    // input fallback to be gone before trusting select ordering/values.
    await expect(reopened.getByPlaceholder('field name')).toHaveCount(0, { timeout: 15_000 });
    await expect(reopened.locator('select').nth(0)).toHaveValue('salary');
    await expect(reopened.locator('select').nth(1)).toHaveValue('gt');
    await expect(reopened.getByPlaceholder('value')).toHaveValue('50000');
  });

  test('transform drawer: invalid computed-field expression is never autosaved', async ({ page }) => {
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragPaletteItemOnto(page, 'Transform', { x: 800, y: 310 });
    await connectNodes(page, 0, 1);

    await page.locator('.react-flow__node').nth(1).click();
    const drawer = page.getByTestId('node-drawer');
    // See the filter-step test above for why a bare "Saved" check is
    // unreliable here — connectNodes's own autosave may still be flashing
    // "Saved" when this click fires; wait for the PUT this click actually
    // triggers.
    const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await drawer.getByRole('button', { name: '+ Computed field' }).click();
    // Adding the step itself autosaves (it starts with a valid, empty literal expression).
    await saved;
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 2_000 });

    await drawer.getByTestId('computed-field-expr').fill('concat(');
    await expect(drawer.getByTestId('computed-field-expr')).toHaveValue('concat(');

    await page.reload();
    await page.locator('.react-flow__node').nth(1).click();
    const reopened = page.getByTestId('node-drawer');
    // The invalid keystrokes never reached onChange (parseExpression rejected
    // them, see TransformEditor.tsx's handleExpressionChange), so the
    // persisted step still has its original { kind: 'literal', value: '' }
    // expression, not "concat(" — stringifyExpression renders that as the
    // quoted empty-string literal `""`, not an empty input.
    await expect(reopened.getByTestId('computed-field-expr')).toHaveValue('""');
  });

  test('two tabs on the same workflow: second save gets a 409 conflict, reload recovers', async ({ browser }) => {
    // Seed a starting node via the primary page fixture so both tabs have
    // something real to move.
    const setupCtx = await browser.newContext({ storageState: personas.canvasA.storageStatePath });
    const setupPage = await setupCtx.newPage();
    await gotoWorkflow(setupPage, 'Canvas E2E Project', 'Canvas E2E Workflow');
    // See the note on the first test in this block: x >= 450 keeps the
    // node's body clear of NodesRail's overlay, which dragNodeBy's
    // real-mouse click-and-drag (below) needs to actually land on the node.
    await dragPaletteItemOnto(setupPage, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragPaletteItemOnto(setupPage, 'Dev sandbox (mongodb)', { x: 450, y: 420 });
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

  /**
   * Checks dock + Run gating (Phase 5 Session 3 Task 2 completion pass).
   * Uses "Dev sandbox (supabase)" for BOTH the source and destination node
   * (same manifestId) deliberately — that keeps checkMappings' heterogeneous
   * path un-triggered (Task 3's real mapping-approval flow hasn't landed
   * yet), so an orphan-node dag failure is the only thing standing between
   * "broken" and "all-pass" here, which is exactly what this test needs to
   * isolate. Requires a live apps/worker consuming the "interactive" BullMQ
   * queue — "Run checks" blocks on a real check_run job round-trip.
   */
  test('checks dock: broken node fails, clicking the failing row highlights it, fixing + re-running passes, Run enables, and clicking it shows the Phase 6 stub', async ({ page }) => {
    await dragRailSectionItemOnto(page, 'Sources', 'Dev sandbox (supabase)', { x: 300, y: 200 });
    // The checks route reads the SERVER's persisted graph (not client state),
    // so the drag's autosave must flush before "Run checks" is clicked, or
    // the run executes against whatever graph was last persisted.
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Run checks' }).click();
    const pill = page.getByTestId('checks-dock-pill');
    await expect(pill).toContainText(/failing/, { timeout: 15_000 });

    const dockBody = page.getByTestId('checks-dock-body');
    const orphanRow = dockBody.getByText(/isn't connected to anything/);
    await expect(orphanRow).toBeVisible();
    await orphanRow.click();

    // "highlighted" = React Flow's own selected-node styling (GraphFlowNode
    // reads the `selected` prop it's passed), driven by the same
    // useCanvasStore.setSelectedNodeId the canvas's own node-click uses —
    // and the drawer opening for that node confirms it's the right one.
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await expect(page.getByTestId('node-drawer')).toBeVisible();

    // handleSelectCheckNode just re-centered the viewport on node 0 — a
    // fixed client-pixel drop point can no longer be trusted to land clear
    // of it, so derive the drop point from node 0's live (post-pan) bounding
    // box instead of a hardcoded screen coordinate. setCenter's pan is a
    // 300ms animated transition, not instantaneous, so the box must be read
    // after it settles or this captures a stale mid-animation position.
    await page.waitForTimeout(400);
    const sourceBox = (await page.locator('.react-flow__node').first().boundingBox())!;
    await dragRailSectionItemOnto(page, 'Destinations', 'Dev sandbox (supabase)', {
      x: sourceBox.x + sourceBox.width + 150,
      y: sourceBox.y,
    });
    await connectNodes(page, 0, 1);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    // Editing the graph after a check run makes the pill visibly stale,
    // even though the fix itself would make the *next* run pass.
    await expect(pill).toContainText(/out of date/i);

    await page.getByRole('button', { name: 'Run checks' }).click();
    await expect(pill).toContainText('All checks passed', { timeout: 15_000 });

    const runBtn = page.getByRole('button', { name: 'Run', exact: true });
    await expect(runBtn).toBeEnabled();
    await runBtn.click();

    await expect(page.getByText('Execution arrives in Phase 6')).toBeVisible();
    await page.getByRole('button', { name: 'Got it' }).click();
    await expect(page.getByText('Execution arrives in Phase 6')).not.toBeVisible();
  });

  test('editing the graph after an all-pass check run flips the pill back to stale and disables Run', async ({ page }) => {
    // x >= 450 for the source: connectNodes below reads its handle position
    // immediately (no re-centering step in this test), so it must clear
    // NodesRail's overlay from the start — see the first test in this
    // block's note for why.
    await dragRailSectionItemOnto(page, 'Sources', 'Dev sandbox (supabase)', { x: 450, y: 200 });
    await dragRailSectionItemOnto(page, 'Destinations', 'Dev sandbox (supabase)', { x: 800, y: 200 });
    await connectNodes(page, 0, 1);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Run checks' }).click();
    const pill = page.getByTestId('checks-dock-pill');
    await expect(pill).toContainText('All checks passed', { timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled();

    await dragPaletteItemOnto(page, 'Transform', { x: 450, y: 450 });
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await expect(pill).toContainText(/out of date/i);
    await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  });

  /**
   * Task 3 item 4's Playwright bullet — manual (no-LLM) mapping approval
   * flow. mysql -> supabase is the heterogeneous pairing (mysql's manifest
   * is etl_source-only; supabase is the only canvasA connection with
   * etl_sink, see palette-purity test above), so this is the first test in
   * the suite to actually exercise checkMappings' heterogeneous path — every
   * earlier checks-dock test deliberately used supabase->supabase to dodge
   * it (see that test's own header comment). The seeded dev-mysql/
   * dev-postgres sandboxes share identical field names (id/name/salary,
   * docker/dev-{mysql,postgres}-init.sql) so real field pickers have real,
   * matching options to select without needing the LLM proposal path (that
   * path is covered live by scripts/mapping-smoke.ts instead, per the plan).
   */
  test('destination drawer: manual field mapping — no approval fails checks, approving passes, editing clears approval and fails again', async ({ page }) => {
    await dragPaletteItemOnto(page, 'Dev sandbox (mysql)', { x: 450, y: 200 });
    await dragRailSectionItemOnto(page, 'Destinations', 'Dev sandbox (supabase)', { x: 800, y: 200 });
    await connectNodes(page, 0, 1);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: 'Run checks' }).click();
    const pill = page.getByTestId('checks-dock-pill');
    await expect(pill).toContainText(/failing/, { timeout: 15_000 });
    await expect(page.getByTestId('checks-dock-body').getByText(/no approved field mapping/)).toBeVisible();
    // The expanded dock body overlaps the drawer's bottom edge (both are
    // bottom-anchored) and intercepts pointer events there — collapse it
    // before opening the drawer so the drawer's own buttons (Approve, in
    // particular) are actually clickable, not just visible.
    await pill.click();
    await expect(page.getByTestId('checks-dock-body')).not.toBeVisible();

    await page.locator('.react-flow__node').nth(1).click();
    const drawer = page.getByTestId('node-drawer');
    // MappingEditor fetches BOTH sides' connection schemas independently
    // (useEntityFields, one call per side) as soon as it mounts. Unlike the
    // transform-editor test above (which waits for an *existing* field
    // <input placeholder="field name"> to disappear), there's no FieldSelect
    // in the DOM yet here — "+ Entry" is what creates the first one, and it
    // defaults the new row to sourceFields[0]/destFields[0]. Clicking it
    // before these two fetches land would default to empty strings, which
    // fails MappingEntry's min(1) validation on the very next render and
    // permanently flips this node into NodeDrawer's read-only "unrecognized
    // config" fallback — so the schema fetches must be awaited first, not
    // the fields *inside* an entry that doesn't exist yet.
    await Promise.all([
      page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema')),
      page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema')),
    ]);
    await expect(drawer.getByText('Field mapping')).toBeVisible();
    await expect(drawer.getByText('Not approved')).toBeVisible();

    await drawer.getByRole('button', { name: '+ Entry' }).click();
    const fromSelect = drawer.locator('select').nth(0);
    const toSelect = drawer.locator('select').nth(1);
    await fromSelect.selectOption('salary');
    await toSelect.selectOption('salary');

    const approved = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await drawer.getByRole('button', { name: 'Approve' }).click();
    await expect(drawer.getByText('Approved')).toBeVisible();
    await approved;
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await expect(pill).toContainText(/out of date/i);
    await page.getByRole('button', { name: 'Run checks' }).click();
    await expect(pill).toContainText('All checks passed', { timeout: 15_000 });
    // Re-running re-expands the dock (FlowCanvas.tsx sets expanded:true on
    // every run) — collapse it again before touching the still-open drawer.
    await pill.click();
    await expect(page.getByTestId('checks-dock-body')).not.toBeVisible();

    // Editing the approved entry clears approvedAt immediately, client-side
    // (updateEntries in MappingEditor.tsx) — no round-trip needed to observe
    // the badge flip, but the edit still autosaves like any other config
    // change, so wait for that PUT before trusting a re-run against the
    // server's persisted graph.
    const edited = page.waitForResponse((res) => res.request().method() === 'PUT' && res.url().includes('/graph'));
    await fromSelect.selectOption('name');
    await expect(drawer.getByText('Not approved')).toBeVisible();
    await edited;
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await expect(pill).toContainText(/out of date/i);
    await page.getByRole('button', { name: 'Run checks' }).click();
    await expect(pill).toContainText(/failing/, { timeout: 15_000 });
    await expect(page.getByTestId('checks-dock-body').getByText(/no approved field mapping/)).toBeVisible();
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
    const rail = page.getByTestId('nodes-rail');
    await expect(rail).toBeVisible();
    await expect(page.locator('.react-flow__node')).toHaveCount(0);

    // Triggers is listed first but isn't backed by any manifest yet
    // (NodesRail.tsx) — locked, non-draggable, "Soon" badge, not a real node.
    const trigger = rail.getByText('Trigger', { exact: true });
    await expect(trigger).toBeVisible();
    await expect(rail.getByText('Soon', { exact: true })).toBeVisible();
    await expect(trigger.locator('..')).not.toHaveAttribute('draggable', 'true');
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

/**
 * The "moat" invariant: NodesRail (Task 1) never lists a tool the actor
 * doesn't actually have. No test above asserted this directly — closing
 * that gap here, one assertion per sub-claim, against real seeded/created
 * workspaces (no mocked connections list). Each sub-claim needs a
 * different persona/connection-shape, so each gets its own describe block
 * (test.use only applies at describe scope, not inside a test body).
 */
test.describe('canvas: palette purity — Triggers moat', () => {
  test.use({ storageState: personas.canvasC.storageStatePath });

  test('Triggers is locked: "Soon" badge, and a drag attempt lands no node on the canvas', async ({ page }) => {
    await gotoWorkflow(page, 'Canvas E2E Personal Project', 'Canvas E2E Personal Workflow');
    const rail = page.getByTestId('nodes-rail');
    const trigger = rail.getByText('Trigger', { exact: true });
    await expect(trigger).toBeVisible();
    await expect(rail.getByText('Soon', { exact: true })).toBeVisible();
    await expect(trigger.locator('..')).not.toHaveAttribute('draggable', 'true');

    // dragPaletteItemOnto dispatches real dragstart/dragover/drop DOM events
    // regardless of the `draggable` attribute — the real invariant under
    // test is that the Triggers entry has no onDragStart handler at all
    // (NodesRail.tsx), so no dataTransfer payload ever reaches the
    // canvas's onDrop, which bails out on an empty payload (FlowCanvas.tsx)
    // and creates nothing.
    await dragPaletteItemOnto(page, 'Trigger', { x: 450, y: 300 });
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
  });
});

test.describe('canvas: palette purity — connection-driven sections', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test('connection-driven sections list only the workspace\'s real connections, never an unconnected tool', async ({ page }) => {
    // Read-only rail inspection — no node create/delete, safe to run
    // independent of the serial drag/connect/reload block above even
    // though it shares the same seeded workflow.
    await gotoWorkflow(page, 'Canvas E2E Project', 'Canvas E2E Workflow');
    const rail = page.getByTestId('nodes-rail');

    await expect(rail.getByText('Sources', { exact: true })).toBeVisible();
    await expect(rail.getByText('Dev sandbox (mysql)', { exact: true })).toBeVisible();
    await expect(rail.getByText('Dev sandbox (mongodb)', { exact: true })).toBeVisible();

    // canvasA (canvas-e2e org) has mysql + mongodb + supabase connections
    // (dev-bootstrap.ts) — supabase's manifest capabilities are
    // ["queryable","etl_source","etl_sink"] (etl_sink added Phase 5 Session
    // 3, see packages/schemas/src/connectors/supabase.ts), so the same
    // connection legitimately appears as BOTH a Sources entry and a
    // Destinations entry (buildEntries in NodesRail.tsx pushes one row per
    // matching capability, not one row per connection).
    await expect(rail.getByText('Dev sandbox (supabase)', { exact: true })).toHaveCount(2);
    await expect(rail.getByText('Destinations', { exact: true })).toBeVisible();

    // Exactly 5 draggable entries total: 3 Sources (mysql, mongodb,
    // supabase) + 1 Destinations (supabase) + the one generic (non-tool)
    // Transform node — nothing invented, nothing extra. mysql/mongodb stay
    // etl_source-only, so neither appears under Destinations.
    await expect(rail.locator('[draggable="true"]')).toHaveCount(5);
  });
});

test.describe('canvas: palette purity — zero-connection persona', () => {
  test.use({ storageState: personas.canvasB.storageStatePath });

  test('a fresh persona with zero connections sees only the locked Trigger and the generic Transform node', async ({ page }) => {
    // canvas-e2e-b has no connections seeded at all (dev-bootstrap.ts only
    // seeds canvas-e2e/canvas-e2e-c) and no project/workflow either — built
    // live via the real UI so this stays a workspace-scoped assertion, not
    // a seed-data special case.
    const projectName = `Palette Purity ${Date.now()}`;
    const workflowName = 'Palette Purity Check';

    await page.goto('/app');
    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    await page.locator('#project-name').fill(projectName);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('link', { name: projectName })).toBeVisible();

    await page.getByRole('button', { name: 'New workflow' }).first().click();
    await page.getByRole('button', { name: 'New workflow', exact: true }).nth(1).click();
    // Explicit select: the dialog's project dropdown defaults to
    // projects[0] (CreateWorkflowDialog.tsx) whenever it's opened without a
    // defaultProjectId, which is NOT necessarily the project just created
    // above once this persona already has other projects (e.g. leftover
    // from a prior run of this same test) — picking by label keeps this
    // deterministic regardless of workspace history.
    await page.locator('#workflow-project').selectOption({ label: projectName });
    await page.locator('#workflow-name').fill(workflowName);
    await page.getByRole('button', { name: 'Create workflow' }).click();

    await gotoWorkflow(page, projectName, workflowName);
    const rail = page.getByTestId('nodes-rail');
    await expect(rail).toBeVisible();

    await expect(rail.getByText('Trigger', { exact: true })).toBeVisible();
    await expect(rail.getByText('Soon', { exact: true })).toBeVisible();
    await expect(rail.getByText('Sources', { exact: true })).toHaveCount(0);
    await expect(rail.getByText('Destinations', { exact: true })).toHaveCount(0);
    await expect(rail.getByText('Transforms', { exact: true })).toBeVisible();
    await expect(rail.getByText('Transform', { exact: true })).toBeVisible();

    // Only one draggable entry in the whole rail — the generic Transform
    // node. No hardcoded tool fills the gap left by zero connections.
    await expect(rail.locator('[draggable="true"]')).toHaveCount(1);
  });
});
