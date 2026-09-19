import { chromium } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:3100/login');
await page.fill('input[name="email"]', 'demo@nia.dev');
await page.fill('input[name="password"]', 'password');
await Promise.all([
  page.waitForURL(/\/app/, { timeout: 10000 }).catch(() => {}),
  page.locator('button[type="submit"]').first().click(),
]);
await page.goto('http://localhost:3100/app/workflows/bbe6e6ad-97cd-444b-9219-d0020de88d28');
await page.waitForSelector('[data-testid="canvas-surface"]', { timeout: 15000 });
await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
await page.waitForTimeout(1000);
const node = page.locator('.react-flow__node').first();
await node.screenshot({ path: '/tmp/live-node-crop.png' });
// header crop
const header = page.locator('header').first();
await header.screenshot({ path: '/tmp/live-header-crop.png' });
// icon rail crop
await page.screenshot({ path: '/tmp/live-rail-crop.png', clip: { x: 0, y: 0, width: 60, height: 900 } });
await browser.close();
console.log('done');
