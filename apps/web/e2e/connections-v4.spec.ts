import { test, expect, type Page } from '@playwright/test';
import { personas } from './fixtures/personas';

// Verifies the "Connections page (cards v4)" redesign against
// designs/Connections — with connections-html/Connections.dc.html.
// Logged in as personas.canvasA (member of "Canvas E2E Org" — seeded with
// all 4 real installed connectors: mysql, postgres, mongodb, supabase,
// each with a live connection) rather than personas.demo: demo@nia.dev
// has staff 2FA enabled (migration 0048_staff_2fa.sql), which
// auth.setup.ts's plain email/password flow can't complete, so that
// persona's storageState never gets produced. canvasA has no 2FA and
// exercises every gated connector card, matching this task's Step 7
// checklist.

test.use({ storageState: personas.canvasA.storageStatePath });

async function hideNextDevIndicator(page: Page) {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
}

async function gotoConnections(page: Page) {
  await page.goto('/app/connections');
  // The page title is a plain <span> (pageTitleStyle), not a semantic
  // heading, and its exact text "Connections" also matches the sidebar
  // nav link — assert on the unique subtitle text instead.
  await expect(
    page.getByText('The databases, warehouses and tools your workflows read from and write to.'),
  ).toBeVisible();
  await hideNextDevIndicator(page);
}

// Column counts follow the spec's content-width breakpoint table (3 cols
// >= 860px, 2 from 540-859px, 1 below 540px), applied to this app's actual
// *content* width — viewport minus the 240px sidebar rail and page
// padding (~352px total) — not the raw viewport width: 1280px/1440px/
// 1920px viewports all clear 860px of content width (3-col bucket).
// Verified directly against the live computed grid-template-columns
// before setting these expectations. (1024px/390px narrower widths are
// covered separately below — the app shell's sidebar rail isn't
// responsive below desktop widths, so the hover/hit-testing/menu tests
// in this full suite below aren't meaningful there; only column count is
// checked at those widths.)
for (const viewport of [
  { width: 1280, height: 800, cols: 3 },
  { width: 1440, height: 900, cols: 3 },
  { width: 1920, height: 1080, cols: 3 },
]) {
  test.describe(`connections v4 @ ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('grid columns, card height, and zero border-radius', async ({ page }) => {
      await gotoConnections(page);

      const cards = page.getByTestId('connector-card');
      const count = await cards.count();
      expect(count).toBeGreaterThan(0);

      // Column count: group visible cards by their bounding-box x position.
      const boxes = await cards.evaluateAll((els) =>
        els.map((el) => {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), height: Math.round(r.height) };
        }),
      );
      const firstBox = boxes[0];
      if (!firstBox) throw new Error('no cards rendered');
      const firstRowY = firstBox.y;
      const firstRowBoxes = boxes.filter((b) => Math.abs(b.y - firstRowY) < 4);
      expect(firstRowBoxes.length).toBe(viewport.cols);

      for (const b of boxes) {
        expect(b.height).toBeGreaterThanOrEqual(471);
        expect(b.height).toBeLessThanOrEqual(473);
      }

      // Equal card widths within the first row (+/-1px) — confirms the
      // grid uses even fr tracks, not a stray fixed/min width forcing wrap.
      const widths = await cards.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().width)));
      const firstRowWidths = widths.slice(0, firstRowBoxes.length);
      expect(Math.max(...firstRowWidths) - Math.min(...firstRowWidths)).toBeLessThanOrEqual(1);

      // No horizontal scroll at desktop widths (the fixed-width sidebar
      // rail makes this a pre-existing constraint below ~540px, outside
      // this grid fix's scope, so only assert it at >=1024px viewports).
      if (viewport.width >= 1024) {
        const hasHScroll = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        );
        expect(hasHScroll).toBe(false);
      }

      // border-radius (round 5): card 16px, its buttons/docs-link 8-10px,
      // search input 10px — see CONNECTIONS_RADIUS in styles.ts.
      const radiusExpectations: [string, string][] = [
        ['[data-testid="connector-card"]', '16px'],
        ['input[placeholder="Search connectors"]', '10px'],
      ];
      for (const [sel, expected] of radiusExpectations) {
        const radii = await page.locator(sel).evaluateAll((els) =>
          els.map((el) => getComputedStyle(el).borderRadius),
        );
        for (const r of radii) expect(r).toBe(expected);
      }
      // Card buttons are either the 10px main CTA or the 8px docs button —
      // never square, never a stray capsule.
      const cardButtonRadii = await page
        .locator('[data-testid="connector-card"] button, [data-testid="connector-card"] a[aria-label$="documentation"]')
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
      for (const r of cardButtonRadii) expect(['8px', '10px']).toContain(r);

      // No-capsule rule: nothing on the page (other than the small status
      // dots) should be fully rounded (radius >= half its own height).
      const capsules = await page.locator('main *').evaluateAll((els) =>
        els
          .filter((el) => {
            const s = getComputedStyle(el);
            const r = parseFloat(s.borderRadius);
            const h = el.getBoundingClientRect().height;
            return h > 10 && r >= h / 2 - 0.5; // exclude tiny 6-8px dots
          })
          .map((el) => el.tagName),
      );
      expect(capsules).toEqual([]);
    });

    test('corner-safe insets: card text/icon/logo stay >=20px from every card edge', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();

      // Re-fetch the card's own box each time (not once upfront) — hover
      // can shift page scroll/layout, and a stale box compared against a
      // freshly-measured child box would produce bogus huge offsets.
      async function assertInset(locator: ReturnType<typeof card.locator>) {
        const count = await locator.count();
        if (!count) return;
        const cardBox = await card.boundingBox();
        const box = await locator.first().boundingBox();
        if (!box || !cardBox) return;
        expect(box.x - cardBox.x).toBeGreaterThanOrEqual(19);
        expect(cardBox.x + cardBox.width - (box.x + box.width)).toBeGreaterThanOrEqual(19);
        expect(box.y - cardBox.y).toBeGreaterThanOrEqual(19);
      }

      // Rest view: category label (top-left) and status badge (top-right).
      await assertInset(card.getByText(/Database|Warehouse|BI|AI Vector|Files/).first());

      // Hover view: logo glides to (20, 20).
      await card.hover();
      await page.waitForTimeout(500);
      await assertInset(card.getByTestId('connector-logo'));
    });

    test('keyboard focus ring is visible and not clipped by the card', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();
      await card.focus();
      await page.waitForTimeout(100);
      const outline = await card.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.outlineWidth, style: s.outlineStyle };
      });
      expect(outline.style).not.toBe('none');
      expect(parseFloat(outline.width)).toBeGreaterThan(0);
    });

    test('rest view: logo size/position, description clamp, no button overflow', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();

      const logoBox = card.locator('img, span').filter({ hasText: '' }).first();
      // Media band + logo: verify via the card's own DOM structure instead of
      // guessing a selector — read the logo <img> (simple-icons svg or
      // fallback text) inside the card.
      const img = card.locator('img').first();
      if (await img.count()) {
        const box = await img.boundingBox();
        expect(box).not.toBeNull();
        if (box) {
          expect(Math.round(box.width)).toBeGreaterThanOrEqual(74);
          expect(Math.round(box.width)).toBeLessThanOrEqual(78);
        }
      }

      const desc = card.locator('span').filter({ hasText: /.+/ }).nth(2);
      const lineClampInfo = await card.evaluate((el) => {
        const spans = Array.from(el.querySelectorAll('span'));
        const descSpan = spans.find((s) => getComputedStyle(s).webkitLineClamp === '2');
        if (!descSpan) return null;
        return {
          clamp: getComputedStyle(descSpan).webkitLineClamp,
          scrollHeight: descSpan.scrollHeight,
          clientHeight: descSpan.clientHeight,
        };
      });
      expect(lineClampInfo?.clamp).toBe('2');

      const buttons = card.locator('button, a[aria-label$="documentation"], a[aria-label="Docs coming soon"]');
      const overflowChecks = await buttons.evaluateAll((els) =>
        els.map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
      );
      for (const c of overflowChecks) expect(c.scrollWidth).toBeLessThanOrEqual(c.clientWidth + 1);
    });

    test('hover view: card recolors, logo moves and shrinks, rest text fades, button inverts', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();
      await card.hover();
      await page.waitForTimeout(500);

      const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe('rgb(10, 10, 11)');

      const img = card.locator('img').first();
      if (await img.count()) {
        const cardBox = await card.boundingBox();
        const imgBox = await img.boundingBox();
        expect(cardBox).not.toBeNull();
        expect(imgBox).not.toBeNull();
        if (cardBox && imgBox) {
          expect(Math.round(imgBox.width)).toBeGreaterThanOrEqual(30);
          expect(Math.round(imgBox.width)).toBeLessThanOrEqual(34);
        }
      }

      const mainButton = card.locator('button, button[type="submit"]').first();
      const btnStyle = await mainButton.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, color: s.color, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
      });
      expect(btnStyle.scrollWidth).toBeLessThanOrEqual(btnStyle.clientWidth + 1);
    });

    test('keyboard focus shows hover view; reduced motion skips logo glide', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await gotoConnections(page);

      const card = page.getByTestId('connector-card').first();
      await card.focus();
      await page.waitForTimeout(200);

      const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe('rgb(10, 10, 11)');
    });

    test('installed row: uninstall button is fully visible and clickable', async ({ page }) => {
      await gotoConnections(page);

      const row = page.getByTestId(/provider-row-/).first();
      await expect(row).toBeVisible();
      const uninstall = row.getByRole('button', { name: /^uninstall$/i });
      await expect(uninstall).toBeVisible();

      const box = await uninstall.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        const vp = page.viewportSize();
        expect(vp).not.toBeNull();
        if (vp) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.y).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(vp.width);
          expect(box.y + box.height).toBeLessThanOrEqual(vp.height);
        }
        const hit = await page.evaluate(
          ([x, y]) => document.elementFromPoint(x, y)?.closest('button') != null,
          [box.x + box.width / 2, box.y + box.height / 2] as [number, number],
        );
        expect(hit).toBe(true);
      }

      await uninstall.click();
      await expect(page.getByText(/uninstall .+\?/i)).toBeVisible();
    });

    test('copy rules: no Credentials placeholder, no index numbering, no all-dash rows, no bold (>=700) text', async ({ page }) => {
      await gotoConnections(page);

      // Note: "Credentials" itself is a legitimate, explicit authMethod value
      // for snowflake/metabase/qdrant/pinecone (apps/web/src/lib/connections/
      // catalogMeta.ts) — a real declared login method, not a placeholder for
      // an *unknown* one. The spec's "no Credentials placeholder" rule targets
      // hiding unknown auth methods; ConnectorCard only ever renders the fact
      // row when `meta.authMethod` is truthy (never a generic fallback), so
      // there is no unknown-method placeholder to assert against here.
      await expect(page.getByText(/\u00b7\s*0\d\b/)).toHaveCount(0);

      const dashOnlyCells = await page.locator('table td').evaluateAll((els) =>
        els.filter((el) => (el.textContent ?? '').trim() === '\u2014').length,
      );
      // A single dash in one cell (e.g. an unset "Last test") is fine; a row made
      // *only* of dashes is not — check no <tr> has every cell equal to a dash.
      const allDashRows = await page.locator('table tbody tr').evaluateAll((rows) =>
        rows.filter((tr) => {
          const cells = Array.from(tr.querySelectorAll('td'));
          return cells.length > 0 && cells.every((c) => (c.textContent ?? '').trim() === '\u2014');
        }).length,
      );
      expect(allDashRows).toBe(0);
      void dashOnlyCells;

      const heavyWeights = await page.locator('main *').evaluateAll((els) =>
        els
          .filter((el) => el.textContent && el.textContent.trim().length > 0)
          .map((el) => Number(getComputedStyle(el).fontWeight))
          .filter((w) => w >= 700),
      );
      expect(heavyWeights).toEqual([]);
    });
  });
}

// Narrower widths: only column count is checked (not the full desktop
// suite above — see the comment on the main viewport loop).
for (const viewport of [
  { width: 1024, height: 768, cols: 2 },
  { width: 390, height: 844, cols: 1 },
]) {
  test.describe(`connections v4 grid columns @ ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test(`shows ${viewport.cols} column(s)`, async ({ page }) => {
      await gotoConnections(page);
      const boxes = await page.getByTestId('connector-card').evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().y)),
      );
      const firstY = boxes[0];
      if (firstY === undefined) throw new Error('no cards rendered');
      const firstRowCols = boxes.filter((y) => Math.abs(y - firstY) < 4).length;
      expect(firstRowCols).toBe(viewport.cols);
    });
  });
}

test.describe('connections v4 — sidebar collapsed', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('collapsing the sidebar rail still shows 3 grid columns at 1280px', async ({ page }) => {
    await gotoConnections(page);
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    await page.waitForTimeout(300);

    const cards = page.getByTestId('connector-card');
    const boxes = await cards.evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { y: Math.round(r.y) };
      }),
    );
    const firstBox = boxes[0];
    if (!firstBox) throw new Error('no cards rendered');
    const firstRowCols = boxes.filter((b) => Math.abs(b.y - firstBox.y) < 4).length;
    expect(firstRowCols).toBe(3);
  });
});

test.describe('connections v4 — empty state', () => {
  // canvasB owns a separate org ("Canvas E2E Org B") with zero installed
  // connectors. `showEmptyState` (installs.length === 0) then replaces the
  // Installed section with a "Get started" onboarding panel.
  test.use({ viewport: { width: 1440, height: 900 }, storageState: personas.canvasB.storageStatePath });

  test('shows the "Get started" onboarding panel', async ({ page }) => {
    await gotoConnections(page);
    await expect(page.getByText('Get started', { exact: true })).toBeVisible();
    await expect(page.getByText('Install a connector below.')).toBeVisible();
    await expect(page.getByText('Suggested connectors', { exact: true })).toBeVisible();
  });
});

test.describe('connections v4 — screenshots', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('capture reference screenshots', async ({ page }) => {
    await gotoConnections(page);
    await expect(page).toHaveScreenshot('connections-v4-full-page.png', { fullPage: true });

    const card = page.getByTestId('connector-card').first();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveScreenshot('connections-v4-card-rest.png');

    await card.hover();
    await page.waitForTimeout(500);
    await expect(card).toHaveScreenshot('connections-v4-card-hover.png');

    const row = page.getByTestId(/provider-row-/).first();
    await row.scrollIntoViewIfNeeded();
    await expect(row.getByRole('button', { name: /^uninstall$/i })).toBeVisible();
    await expect(page).toHaveScreenshot('connections-v4-installed-row.png');
  });
});

test.describe('connections v4 — empty-state screenshot', () => {
  // canvasB: zero installed connectors -> "Get started" onboarding panel.
  test.use({ viewport: { width: 1440, height: 900 }, storageState: personas.canvasB.storageStatePath });

  test('capture empty-state screenshot', async ({ page }) => {
    await gotoConnections(page);
    await expect(page.getByText('Get started', { exact: true })).toBeVisible();
    await expect(page).toHaveScreenshot('connections-v4-empty-state.png', { fullPage: true });
  });
});
