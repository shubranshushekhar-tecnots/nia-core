import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { personas } from './fixtures/personas';
import { createProjectAndWorkflow, gotoWorkflow } from './fixtures/flows';

/**
 * Learning-mode Step 4 (docs/plans/learning-mode.md) — HelpPanel wired into
 * GrantAccessPanel and RevokeAccessPanel (NodeDrawer.tsx). Covers the
 * accessibility contract HelpPanel.tsx's own header documents (open via
 * keyboard, Esc closes, focus returns to the trigger) plus the "Copy only
 * with real values" invariant enforced by apps/web/src/lib/help/
 * resolveHelpSql.ts — proven here not just by the Copy button's presence,
 * but by asserting the help panel's statement is byte-identical to the
 * exact statement the real panel goes on to use (same generator, same
 * credential), never the shared illustration placeholder.
 *
 * Reuses canvas.spec.ts's "empty-database postgres destination" setup
 * (own project/workflow/connection, ensureEmptyPostgresDatabase) to reach a
 * real GrantAccessPanel, then a real RevokeAccessPanel once confirmed —
 * intentionally stops short of approving/running the workflow, since this
 * test only exercises the help panel, not the write path itself (see
 * canvas.spec.ts for that full run coverage).
 */
function ensureEmptyPostgresDatabase() {
  const exists = execSync(`docker exec nia-core-dev-postgres-1 psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='empty_e2e'"`)
    .toString()
    .trim();
  if (exists === '1') return;
  execSync(`docker exec nia-core-dev-postgres-1 psql -U postgres -c "CREATE DATABASE empty_e2e"`);
  execSync(
    `docker exec nia-core-dev-postgres-1 psql -U postgres -d empty_e2e -c "GRANT CONNECT ON DATABASE empty_e2e TO nia_ro; GRANT USAGE ON SCHEMA public TO nia_ro; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT ON TABLES TO nia_ro;"`,
  );
}

// Rail helpers mirror canvas.spec.ts's — see NodesRail.tsx: connectors now
// render once each under a single "Connections" group, carrying every role
// they support; FlowCanvas.tsx's drop-role picker resolves ambiguous
// (multi-role) drops instead of the old per-section duplicate rows.
async function dragRailSectionItemOnto(page: Page, role: 'source' | 'destination', label: string, point: { x: number; y: number }) {
  const rail = page.getByTestId('nodes-rail');
  const item = rail.getByText(label, { exact: true });
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await item.dispatchEvent('dragstart', { dataTransfer });
  const surface = page.getByTestId('canvas-surface');
  await surface.dispatchEvent('dragover', { dataTransfer, clientX: point.x, clientY: point.y });
  await surface.dispatchEvent('drop', { dataTransfer, clientX: point.x, clientY: point.y });

  const picker = page.getByTestId('drop-role-picker');
  if (await picker.isVisible().catch(() => false)) {
    const roleLabel = role === 'source' ? 'Source' : 'Destination';
    await picker.getByRole('menuitem', { name: `Use as ${roleLabel}` }).click();
  }
}

async function clickRailSectionItem(page: Page, label: string) {
  const rail = page.getByTestId('nodes-rail');
  await rail.getByText(label, { exact: true }).click();
}

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

test.describe('canvas: HelpPanel from GrantAccessPanel / RevokeAccessPanel', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test('opens via keyboard, Esc closes with focus restored to the trigger, and Copy only ever shows the real generated statement', async ({ page }) => {
    ensureEmptyPostgresDatabase();

    await page.goto('/app/connections');
    const installBtn = page.getByRole('button', { name: 'Install PostgreSQL' });
    if (await installBtn.isVisible().catch(() => false)) {
      await installBtn.click();
      await expect(installBtn).not.toBeVisible();
    }

    const projectName = `Help Panel E2E ${Date.now()}`;
    const workflowName = 'Help Panel E2E Check';
    await createProjectAndWorkflow(page, projectName, workflowName);
    await gotoWorkflow(page, projectName, workflowName);

    await dragRailSectionItemOnto(page, 'source', 'Dev sandbox (mysql)', { x: 450, y: 200 });

    // PostgreSQL may already be connected for canvasA's org (a prior run) —
    // probe for whichever branch is actually present instead of assuming
    // execution order (see canvas.spec.ts for the same pattern).
    const rail = page.getByTestId('nodes-rail');
    const unconnectedRow = rail.getByText('PostgreSQL', { exact: true });
    if (await unconnectedRow.isVisible().catch(() => false)) {
      await clickRailSectionItem(page, 'PostgreSQL');
    } else {
      await rail.locator('[title="Add another PostgreSQL connection"]').click();
    }
    await expect(page.getByText('Add PostgreSQL connection')).toBeVisible();
    const connectionName = `Help Panel E2E ${Date.now()}`;
    await page.locator('#connection-display-name').fill(connectionName);
    await page.locator('#connection-field-host').fill('dev-postgres');
    await page.locator('#connection-field-port').fill('5432');
    await page.locator('#connection-field-database').fill('empty_e2e');
    await page.locator('#connection-field-ssl').uncheck();
    await page.locator('#connection-field-user').fill('nia_ro');
    await page.locator('#connection-field-password').fill('nia_ro_pw');
    await page.getByRole('button', { name: 'Add connection' }).click();
    await expect(page.getByText('Add PostgreSQL connection')).not.toBeVisible();

    await dragRailSectionItemOnto(page, 'destination', connectionName, { x: 800, y: 200 });
    await connectNodes(page, 0, 1);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    await page.locator('.react-flow__node').nth(0).click();
    await page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema'));
    const sourceDrawer = page.getByTestId('node-drawer');
    const sourceTableSelect = sourceDrawer.locator('select').first();
    const employeesValue = await sourceTableSelect.locator('option', { hasText: 'employees' }).getAttribute('value');
    await sourceTableSelect.selectOption(employeesValue!);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    // NodeConfigPanel is a real flex sibling (see canvas/styles.ts's
    // configPanelShellStyle, workflow canvas redesign), not an absolute
    // overlay, so the pane visibly shrinks while it's open — a hardcoded
    // offset can land past the pane's own (now narrower) edge and get
    // intercepted by the docked panel next to it. No explicit position:
    // Playwright targets the element's own (correctly shrunk) visible
    // center instead, which is always inside the pane.
    await page.locator('.react-flow__pane').click();
    await page.locator('.react-flow__node').nth(1).click();
    const drawer = page.getByTestId('node-drawer');
    await page.waitForResponse((res) => res.request().method() === 'GET' && res.url().includes('/schema'));

    const tableSelect = drawer.locator('select');
    await tableSelect.selectOption('__new__');
    await drawer.getByPlaceholder('namespace').fill('public');
    const tableName = `help_panel_e2e_${Date.now()}`;
    await drawer.getByPlaceholder('new table name').fill(tableName);
    await expect(page.getByText('Saved')).toBeVisible({ timeout: 5_000 });

    // --- GrantAccessPanel's help trigger, before any grant is minted ---
    await expect(drawer.getByText('Grant write access to "public"')).toBeVisible();
    const grantHelpTrigger = drawer.getByRole('button', { name: 'Help with this step' });

    // Open via keyboard: focus the trigger and press Enter, not a click.
    await grantHelpTrigger.focus();
    await page.keyboard.press('Enter');

    const grantHelpDialog = page.getByRole('dialog', { name: 'Grant write access help for Postgres' });
    await expect(grantHelpDialog).toBeVisible();
    await expect(grantHelpDialog.getByRole('button', { name: 'Copy statement' })).toBeVisible();
    const grantHelpStatement = await grantHelpDialog.locator('pre').innerText();
    // Never the shared illustration placeholder — a real, currently-active
    // credential (GrantAccessPanel's own generated one) is already available
    // at this point, even before "Grant write access" is clicked.
    expect(grantHelpStatement).not.toContain('REPLACEWITHGENERATEDPASSWORD');
    expect(grantHelpStatement).not.toContain('nia_write_user');

    // Esc closes, and focus returns to the trigger that opened it.
    await page.keyboard.press('Escape');
    await expect(grantHelpDialog).not.toBeVisible();
    await expect(grantHelpTrigger).toBeFocused();

    // Mint the grant for real — GrantAccessPanel's own <pre> must be
    // byte-identical to what the help panel just showed: same generator
    // function, same credential (see NodeDrawer.tsx's helpValues).
    await drawer.getByRole('button', { name: 'Grant write access' }).click();
    const grantDdl = await drawer.locator('pre').innerText();
    expect(grantDdl).toBe(grantHelpStatement);
    execSync(`docker exec -i nia-core-dev-postgres-1 psql -U postgres -d empty_e2e`, { input: grantDdl });
    await drawer.getByRole('button', { name: "I've run this — confirm access" }).click();
    await expect(drawer.getByText('Write access granted')).toBeVisible({ timeout: 10_000 });

    // --- RevokeAccessPanel's help trigger, once the grant is confirmed ---
    const revokeHelpTrigger = drawer.getByRole('button', { name: 'Help with this step' });
    await revokeHelpTrigger.focus();
    await page.keyboard.press('Enter');

    const revokeHelpDialog = page.getByRole('dialog', { name: 'Revoke access help for Postgres' });
    await expect(revokeHelpDialog).toBeVisible();
    await expect(revokeHelpDialog.getByRole('button', { name: 'Copy statement' })).toBeVisible();
    const revokeHelpStatement = await revokeHelpDialog.locator('pre').innerText();

    await page.keyboard.press('Escape');
    await expect(revokeHelpDialog).not.toBeVisible();
    await expect(revokeHelpTrigger).toBeFocused();

    // Same byte-identical check against the real DROP ROLE statement
    // (RevokeAccessPanel's own "Show role removal statement" details).
    await drawer.getByText('Show role removal statement').click();
    const dropStatement = await drawer.locator('pre').innerText();
    expect(revokeHelpStatement).toBe(dropStatement);
  });
});
