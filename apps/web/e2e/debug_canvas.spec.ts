import { test, expect } from '@playwright/test';
import { personas } from './fixtures/personas';

test.use({ storageState: personas.canvasA.storageStatePath });

test('debug nav', async ({ page }) => {
  page.on('console', (m) => console.log('CONSOLE', m.type(), m.text()));
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('requestfailed', (r) => console.log('REQFAILED', r.url(), r.failure()?.errorText));
  page.on('response', (r) => { if (r.status() >= 300 && r.status() < 400) console.log('REDIRECT', r.status(), r.url()); });
  await page.goto('/app/projects');
  await page.getByRole('link', { name: 'Canvas E2E Project', exact: true }).click();
  console.log('AFTER PROJECT CLICK', page.url());
  await page.getByRole('link', { name: 'Canvas E2E Workflow' }).click();
  console.log('AFTER WORKFLOW CLICK', page.url());
  await page.waitForTimeout(2000);
  console.log('AFTER WAIT', page.url());
});
