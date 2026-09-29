import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3100/login');
await page.fill('input[name="email"]', 'demo@nia.dev');
await page.fill('input[name="password"]', 'password');
await Promise.all([
  page.waitForURL(/\/(app|console)/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);
await page.goto('http://localhost:3100/console/orgs/e6bf7df7-32e8-497e-8c77-91f096037020');
await page.waitForSelector('text=Members', { timeout: 15000 });
await page.waitForTimeout(500);
await page.screenshot({ path: '/tmp/console-org-detail-1440.png', fullPage: true });
console.log('done, url:', page.url());
await browser.close();
