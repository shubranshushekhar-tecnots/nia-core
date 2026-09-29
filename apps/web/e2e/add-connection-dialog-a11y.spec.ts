import { test, expect } from '@playwright/test';
import { personas } from './fixtures/personas';
import { createProjectAndWorkflow, gotoWorkflow } from './fixtures/flows';

/**
 * Learning-mode Step 8 accessibility pass (docs/plans/learning-mode.md) —
 * AddConnectionDialog.tsx now uses useModalA11y (apps/web/src/lib/a11y/
 * useModalDialog.ts) for Esc-to-close + focus trap + focus restore. Same
 * "Esc closes, focus returns to the trigger" contract help-panel.spec.ts
 * already proves for HelpPanel, applied here to the outer Add-connection
 * dialog itself.
 *
 * Trigger: NodesRail.tsx's "+ New connection" row (title="Add another
 * MySQL connection"), a real <button> that only renders once a connector
 * already has at least one connection — canvasA's fixture always has a
 * real MySQL connection (see fixtures/personas.ts), so this is
 * deterministic without any drag/drop or dialog-branch setup. Opened via
 * keyboard (.focus() + Enter, not a mouse click) to prove the trigger
 * itself is keyboard-reachable too.
 */
test.describe('canvas: AddConnectionDialog accessibility', () => {
  test.use({ storageState: personas.canvasA.storageStatePath });

  test('Esc closes the dialog and returns focus to the trigger that opened it', async ({ page }) => {
    const projectName = `Add Connection A11y E2E ${Date.now()}`;
    const workflowName = 'Add Connection A11y E2E Check';
    await createProjectAndWorkflow(page, projectName, workflowName);
    await gotoWorkflow(page, projectName, workflowName);

    const rail = page.getByTestId('nodes-rail');
    const trigger = rail.locator('[title="Add another MySQL connection"]');
    await trigger.focus();
    await page.keyboard.press('Enter');

    const dialog = page.getByRole('dialog', { name: 'Add MySQL connection' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
});
