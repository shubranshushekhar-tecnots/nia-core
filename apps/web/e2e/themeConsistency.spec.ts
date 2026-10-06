import { test, expect, type Page } from '@playwright/test';

// Confirms /downloads and /docs/agent/getting-started actually share the
// app's Precision Dark theme with /login, rather than relying on a visual
// diff: reads the real computed background-color and body font-family off
// each page and asserts they match, in both themes. Run with:
//   npx playwright test -c playwright.theme.config.ts
// (not the main playwright.config.ts — see that file's own header comment
// for why this spec needs none of its globalSetup/auth overhead).

const PAGES = [
  { path: '/login', label: 'login' },
  { path: '/downloads', label: 'downloads' },
  { path: '/docs/agent/getting-started', label: 'getting-started' },
];

async function readTheme(page: Page) {
  return page.evaluate(() => {
    // The painted background/font live on the [data-app-theme] root each
    // page renders (AuthShell, DownloadsPage, DocsLayout all set it inline
    // via nx-bg/nx-font-ui) — document.body itself just carries a global
    // Tailwind reset color, which is theme-invariant and would make this
    // assertion meaningless.
    const root = document.querySelector('[data-app-theme]');
    if (!root) throw new Error('No [data-app-theme] element found on this page.');
    const cs = getComputedStyle(root);
    return {
      backgroundColor: cs.backgroundColor,
      fontFamily: cs.fontFamily,
      htmlThemeAttr: document.documentElement.getAttribute('data-nx-theme'),
    };
  });
}

async function gotoWithTheme(page: Page, path: string, theme: 'light' | 'dark') {
  // next-themes persists to localStorage under "nia-theme" (see
  // ThemeProvider setup in src/app/layout.tsx). Setting it via an
  // in-page evaluate + reload (rather than addInitScript, which keeps
  // accumulating scripts across navigations on a shared page and made
  // this flaky) guarantees exactly the requested theme is active on the
  // page actually under test.
  await page.goto(path);
  await page.evaluate((t) => window.localStorage.setItem('nia-theme', t), theme);
  await page.reload();
  await page.waitForLoadState('networkidle');
}

test.describe('theme consistency across public pages', () => {
  test('dark mode: background + font family match across login/downloads/docs', async ({ page }) => {
    const results: Record<string, { backgroundColor: string; fontFamily: string }> = {};
    for (const { path, label } of PAGES) {
      await gotoWithTheme(page, path, 'dark');
      const theme = await readTheme(page);
      expect(theme.htmlThemeAttr).toBe('dark');
      results[label] = theme;
      await page.screenshot({ path: `/tmp/theme-dark-${label}.png`, fullPage: true });
    }

    const loginTheme = results.login;
    if (!loginTheme) throw new Error('No theme recorded for /login.');
    for (const { label } of PAGES.slice(1)) {
      const other = results[label];
      if (!other) throw new Error(`No theme recorded for ${label}.`);
      expect(other.backgroundColor).toBe(loginTheme.backgroundColor);
      expect(other.fontFamily).toBe(loginTheme.fontFamily);
    }
  });

  test('toggling theme changes background on all three pages', async ({ page }) => {
    for (const { path } of PAGES) {
      await gotoWithTheme(page, path, 'dark');
      const dark = await readTheme(page);

      await gotoWithTheme(page, path, 'light');
      const light = await readTheme(page);

      expect(light.backgroundColor).not.toBe(dark.backgroundColor);
    }
  });
});
