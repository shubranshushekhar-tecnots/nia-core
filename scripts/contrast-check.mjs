#!/usr/bin/env node
// UI-9 step 4 (contrast): computes WCAG contrast ratios for every
// --nx-* text/background pair actually used in apps/web, straight from
// packages/ui/src/theme.css's dark and light token blocks — no visual
// inspection, no hardcoded hex values here. Run with:
//   node scripts/contrast-check.mjs
// Exit code is non-zero if any non-exempt pair fails its WCAG threshold.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const themePath = join(__dirname, '..', 'packages', 'ui', 'src', 'theme.css');
const css = readFileSync(themePath, 'utf8');

function extractBlock(selectorRegex) {
  const m = css.match(selectorRegex);
  if (!m) throw new Error(`Could not find block for ${selectorRegex}`);
  const start = m.index + m[0].length;
  const end = css.indexOf('}', start);
  const body = css.slice(start, end);
  const tokens = {};
  for (const line of body.split('\n')) {
    const tm = line.match(/--nx-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})\s*;/);
    if (tm) tokens[tm[1]] = tm[2];
  }
  return tokens;
}

const dark = extractBlock(/html\[data-nx-theme='dark'\]\s*\[data-app-theme\]\s*\{/);
const light = extractBlock(/html\[data-nx-theme='light'\]\s*\[data-app-theme\]\s*\{/);

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function relLuminance([r, g, b]) {
  const chan = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [rl, gl, bl] = [chan(r), chan(g), chan(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}

function contrastRatio(hexA, hexB) {
  const la = relLuminance(hexToRgb(hexA));
  const lb = relLuminance(hexToRgb(hexB));
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

// pairs: [label, fgTokenName, bgTokenName, requirement]
// requirement: 'body' (4.5:1), 'large' (3:1), or 'exempt' (listed, not enforced)
const INK_TOKENS = ['ink', 'ink-2', 'ink-3', 'ink-disabled'];
const BG_TOKENS = ['bg', 'surface', 'raised'];

const pairs = [];
for (const fg of INK_TOKENS) {
  for (const bg of BG_TOKENS) {
    pairs.push([`${fg} on ${bg}`, fg, bg, fg === 'ink-disabled' ? 'exempt' : 'body']);
  }
}
pairs.push(['blue-panel-text on blue-panel', 'blue-panel-text', 'blue-panel', 'body']);
pairs.push(['blue-cta-text on blue-cta', 'blue-cta-text', 'blue-cta', 'body']);
// nx-danger is used as a solid button background with nx-bg as its text
// color (members/styles.ts nxMembersDialogConfirmCellStyle, non-pending
// state) — the only "text on danger" pair that actually exists in the app.
pairs.push(['bg on danger (solid danger button text)', 'bg', 'danger', 'body']);
pairs.push(['danger-text on bg', 'danger-text', 'bg', 'body']);
pairs.push(['danger-text on danger-tint', 'danger-text', 'danger-tint', 'body']);
pairs.push(['warn on bg', 'warn', 'bg', 'body']);
// warn has no dedicated --nx-warn-tint token; --nx-raised is the surface
// it's actually rendered against (ChecksDock.tsx, announcementBannerStyles.ts).
pairs.push(['warn on raised (its tint surface)', 'warn', 'raised', 'body']);

const THRESHOLDS = { body: 4.5, large: 3, exempt: 0 };

function runTheme(name, tokens) {
  console.log(`\n=== ${name} ===`);
  const rows = [];
  for (const [label, fgKey, bgKey, req] of pairs) {
    const fg = tokens[fgKey];
    const bg = tokens[bgKey];
    if (!fg || !bg) {
      console.log(`  SKIP  ${label} — missing token(s)`);
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    const threshold = THRESHOLDS[req];
    const pass = req === 'exempt' ? null : ratio >= threshold;
    rows.push({ label, fg, bg, ratio, req, pass });
  }
  const labelW = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const status = r.pass === null ? 'EXEMPT' : r.pass ? 'PASS' : 'FAIL';
    console.log(
      `  ${status.padEnd(6)} ${r.label.padEnd(labelW)}  ${r.ratio.toFixed(2)}:1  (need ${r.req === 'exempt' ? 'n/a' : THRESHOLDS[r.req] + ':1'})  [${r.fg} on ${r.bg}]`
    );
  }
  return rows;
}

const darkRows = runTheme('dark', dark);
const lightRows = runTheme('light', light);

const failures = [...darkRows, ...lightRows].filter((r) => r.pass === false);
console.log(`\n${failures.length} failing pair(s) out of ${darkRows.length + lightRows.length} checked (excluding exempt).`);
process.exit(failures.length > 0 ? 1 : 0);
