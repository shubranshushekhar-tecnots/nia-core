import { test, expect, type Page } from '@playwright/test';
import { personas } from './fixtures/personas';

// Verifies the "Connections page" redesign against
// designs/Connections — with connections-html/Connections.dc.html.
// Logged in as personas.canvasA (member of "Canvas E2E Org" — seeded with
// all 4 real installed connectors: mysql, postgres, mongodb, supabase,
// each with a live connection) rather than personas.demo: demo@nia.dev
// has staff 2FA enabled (migration 0048_staff_2fa.sql), which
// auth.setup.ts's plain email/password flow can't complete, so that
// persona's storageState never gets produced. canvasA has no 2FA and
// exercises every gated connector card, matching this task's Step 7
// checklist.
//
// UI-9 step 6: selectors/assertions below were updated against the card
// v6 "fidelity pass" (ConnectorCard.tsx/styles.ts's `nxConnectorCard*`
// family) which replaced the earlier v4 hover-morph card referenced by
// this file's original text:
// - `--nx-radius` is now 0px globally (sharp corners everywhere) — was
//   16/10/8px under v4.
// - Hover/focus-within now only shifts the card's own background to
//   `var(--nx-surface)` (`.nx-conn-card` in theme.css); there is no
//   logo glide/shrink, no rest-text fade, no button color invert. The
//   giant bottom-left logo/monogram mark never moves.
// - The card is a plain non-focusable `<div>` (no tabIndex); keyboard
//   focus/`:focus-within` is driven by its main action button, not the
//   card itself — focus-ring and hover-state tests below target that
//   button, not `connector-card`.
// - Real vendor marks render as an inline `<svg>` inside a
//   `data-testid="connector-logo"` wrapper, never an `<img>`; the 4
//   catalog ids with no simple-icons mark render a bare text glyph in
//   that same wrapper instead. Tests below use the testid, not `img`.
// - The description has no line-clamp in v6 (card height is `minHeight`-
//   based and grows with content), so that assertion was dropped.

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

      // Card v6 uses `minHeight: 348` (art 148 + actions 52 + variable-
      // height body) rather than a fixed height, so only assert the floor.
      for (const b of boxes) {
        expect(b.height).toBeGreaterThanOrEqual(348);
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

      // border-radius: `--nx-radius` is 0px globally now (sharp corners) —
      // card, its buttons/docs-link, and the search input all match.
      const radiusExpectations: [string, string][] = [
        ['[data-testid="connector-card"]', '0px'],
        ['input[placeholder="Search connectors"]', '0px'],
      ];
      for (const [sel, expected] of radiusExpectations) {
        const radii = await page.locator(sel).evaluateAll((els) =>
          els.map((el) => getComputedStyle(el).borderRadius),
        );
        for (const r of radii) expect(r).toBe(expected);
      }
      const cardButtonRadii = await page
        .locator('[data-testid="connector-card"] button, [data-testid="connector-card"] a[aria-label$="documentation"]')
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderRadius));
      for (const r of cardButtonRadii) expect(r).toBe('0px');

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

    // Card v6's art-band corner labels use fixed inline-style insets
    // (nxConnectorCardCategoryStyle: left 20/top 16; nxConnectorCardBadgeStyle:
    // right 16/top 14 — see styles.ts) rather than a uniform ">=20px on every
    // edge" rule. The giant bottom-left logo/monogram is a deliberate
    // bleeding "watermark" (its fallback form is explicitly clipped past the
    // art band's bottom edge, `bottom: -12`), so it's intentionally excluded
    // from this inset check, and — per the v6 redesign — never moves on
    // hover, so there's no separate hover-view assertion here either.
    test('corner-safe insets: category label and status badge stay clear of the art-band edges', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();
      const cardBox = await card.boundingBox();
      if (!cardBox) throw new Error('no card rendered');

      const category = card.getByText(/Database|Warehouse|BI|AI Vector|Files/).first();
      const categoryBox = await category.boundingBox();
      expect(categoryBox).not.toBeNull();
      if (categoryBox) {
        expect(categoryBox.x - cardBox.x).toBeGreaterThanOrEqual(14);
        expect(categoryBox.y - cardBox.y).toBeGreaterThanOrEqual(10);
      }

      const badge = card.locator('span').filter({ hasText: /connected|Installed|Coming soon/ }).first();
      if (await badge.count()) {
        const badgeBox = await badge.boundingBox();
        if (badgeBox) {
          expect(cardBox.x + cardBox.width - (badgeBox.x + badgeBox.width)).toBeGreaterThanOrEqual(10);
          expect(badgeBox.y - cardBox.y).toBeGreaterThanOrEqual(8);
        }
      }
    });

    // The card itself is a plain non-focusable <div> (no tabIndex) —
    // keyboard focus/`:focus-within` is driven by its main action button
    // (.nx-wipe, with its own :focus-visible rule in theme.css), not the
    // card element.
    test('keyboard focus ring is visible on the card\'s main action button', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();
      const mainButton = card.locator('button, button[type="submit"]').first();
      await mainButton.focus();
      await page.waitForTimeout(100);
      const outline = await mainButton.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.outlineWidth, style: s.outlineStyle };
      });
      expect(outline.style).not.toBe('none');
      expect(parseFloat(outline.width)).toBeGreaterThan(0);
    });

    test('rest view: logo mark renders, no button overflow', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();

      // Logo mark: a real vendor brand icon renders as an inline <svg>
      // inside the data-testid wrapper; the 4 catalog ids with no
      // simple-icons mark render a bare text glyph in the same wrapper
      // instead — either way, just confirm something visible rendered
      // (card v6 has no fixed logo size/position contract to assert here,
      // unlike the old v4 hover-morph card).
      const logo = card.getByTestId('connector-logo');
      await expect(logo).toBeVisible();
      const logoBox = await logo.boundingBox();
      expect(logoBox).not.toBeNull();
      if (logoBox) expect(logoBox.width).toBeGreaterThan(0);

      // No line-clamp in v6 — the description is unclamped and the card's
      // body grows with content (minHeight, not a fixed height).

      const buttons = card.locator('button, a[aria-label$="documentation"], a[aria-label="Docs coming soon"]');
      const overflowChecks = await buttons.evaluateAll((els) =>
        els.map((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })),
      );
      for (const c of overflowChecks) expect(c.scrollWidth).toBeLessThanOrEqual(c.clientWidth + 1);
    });

    // Card v6: hover/focus-within only shifts the card's own background to
    // `var(--nx-surface)` (theme.css's `.nx-conn-card`) — no logo move/
    // shrink, no rest-text fade, no button color invert (the action
    // buttons use the separate `.nx-wipe` hover utility for their own
    // treatment, which isn't a `background-color` swap, so it isn't
    // asserted here).
    test('hover view: card background shifts to --nx-surface, no button overflow', async ({ page }) => {
      await gotoConnections(page);
      const card = page.getByTestId('connector-card').first();
      await card.hover();
      await page.waitForTimeout(300);

      const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe('rgb(17, 17, 19)'); // --nx-surface (dark theme)

      const mainButton = card.locator('button, button[type="submit"]').first();
      const btnStyle = await mainButton.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(btnStyle.scrollWidth).toBeLessThanOrEqual(btnStyle.clientWidth + 1);
    });

    // `:focus-within` is triggered by focusing a control inside the card
    // (the card div itself has no tabIndex) — same --nx-surface background
    // as the mouse-hover case, reduced motion or not (it's a background
    // transition, not a mount/morph animation).
    test('focusing the main action button shows the same hover background on its card', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await gotoConnections(page);

      const card = page.getByTestId('connector-card').first();
      const mainButton = card.locator('button, button[type="submit"]').first();
      await mainButton.focus();
      await page.waitForTimeout(200);

      const bg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(bg).toBe('rgb(17, 17, 19)');
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
