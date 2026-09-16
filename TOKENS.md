# Design Tokens — extracted from `designs/*.html`

All values below were pulled directly from the three exported HTML files via targeted
grep on the inline `:root{...}` blocks, `@font-face` declarations, and repeated
inline-style patterns. Nothing here is invented or approximated. Where something is
ambiguous or needs a decision, it's flagged under **⚠️ Needs your input**.

## Important structural discovery

`designs/Nia Core App.html` is **not single-themed** — it contains a runtime JS switch
(`v.appRootStyle`) that overrides the whole `:root` palette + font stack when
`page ∈ {orgdash, connections, billing, automation, project, projects, home, members,
settings}` **and** `auth === 'app'` **and** `theme === 'light'`. That override uses:

- Indigo palette identical to Console/Landing (`--primary:#4F46E5`, `--acc-bg:#EEF2FF`, etc.)
- `font-family:'Satoshi'` for both `--font-display` and `--font-ui`

The file's *default* `:root` (no override) is a separate **dark** theme ("Midnight Navy")
using `--font-display:'Bricolage Grotesque'` and `--font-ui:'Schibsted Grotesk'`.
There's also a third, unused-looking `:root[data-om-theme="light"]` CSS block ("Warm
White world") with yet another palette (`--acc:#5C7699`, `--live:#92502F`) — this is
shadowed by the inline JS override on every page you listed as "light theme" in your
brief, so it appears to be dead/legacy CSS rather than what's actually rendered.

**Net effect:** the screens you asked for in light theme (Home, Projects, Org dashboard,
Members & roles, Billing, Settings, Connections, ETL/automation) all render with the
**same Satoshi + indigo system as Console and Landing**. The Bricolage/Schibsted dark
theme appears to be a separate "Midnight Navy" mode not in your current screen list.

---

## 1. Colors

### Shared across App (light/"app" mode), Console, Landing
| Token | Value | Role |
|---|---|---|
| `--primary` / `--acc` | `#4F46E5` | Indigo primary |
| `--primary-hover` | `#4338CA` | Primary hover/active |
| `--primary-soft` / `--acc-bg` | `#EEF2FF` | Primary tint bg |
| `--acc-bd` | `#C7D2FE` | Primary border tint |
| `--chart-1` | `#6366F1` | Secondary indigo (charts) |
| `--page` / `--bg` | `#F8FAFC` | App background |
| `--surface` / `--raised` | `#FFFFFF` | Card/panel surface |
| `--surface2` / `--subtle` / `--overlay` | `#F1F5F9` | Sunken surface |
| `--text` / `--ink` | `#0F172A` | Primary text |
| `--text-2` / `--secondary` / `--ink2` | `#475569` | Secondary text |
| `--text-3` / `--muted` / `--ink3` | `#94A3B8` (Console) / `#64748B` (App) | Tertiary text |
| `--line` | `#E2E8F0` | Divider |
| `--line2` / `--line-strong` | `#CBD5E1` | Stronger divider/border |
| `--ok` / `--success` | `#10B981` | Success |
| `--success-deep` | `#047857` | Success (deep/text-on) |
| `--warn` / `--warning` | `#F59E0B` | Warning / amber accent |
| `--warning-deep` | `#B45309` | Warning deep (also **INTERNAL badge text**) |
| `--bad` / `--fail` / `--error` | `#EF4444` | Error |
| `--error-deep` | `#B91C1C` | Error deep |
| `--info` | `#0EA5E9` | Info (console only, confirmed) |

### Flow/ETL node accent colors (App automation canvas + Landing demo)
| Token | Value |
|---|---|
| `--c-trigger` | `#4F46E5` |
| `--c-action` | `#2563EB` |
| `--c-condition` | `#7C3AED` |
| `--c-data` | `#0891B2` |
| `--c-ai` | `#6366F1` |

### App "Midnight Navy" dark theme (default `:root`, before the light override fires)
| Token | Value |
|---|---|
| `--page` / `--bg` | `#131A26` |
| `--surface` | `#18202F` |
| `--raised` / `--surface2` | `#1E2735` |
| `--overlay` | `#27303F` |
| `--text` / `--ink` | `#FAF7F2` |
| `--text-2` / `--ink2` | `#B9C2CE` |
| `--text-3` / `--ink3` | `#68748A` |
| `--line` | `#2A3444` |
| `--line2` / `--line-strong` | `#39455A` |
| `--live` / `--acc-solid` | `#C98757` (copper) |
| `--ok` | `#4CAF82` |
| `--warn` | `#D9A03F` |
| `--bad` / `--fail` | `#E06A5E` |
| shadow `--shadow` | `0 32px 80px rgba(5,9,16,.62)` |
| shadow `--drop` | `0 18px 40px rgba(5,9,16,.5)` |
| shadow `--amb` | `0 8px 24px rgba(5,9,16,.4)` |

⚠️ **Needs your input:** since none of the 7 App screens you listed actually render this
dark theme (they're all forced to the Satoshi/indigo palette per the JS switch above), do
you still want this "Midnight Navy" theme built as a real dark-mode toggle, or should I
leave it out of scope until a screen that uses it is identified?

### Console "INTERNAL" badge (verified from inline style)
```
padding: 4px 10px; border-radius: 7px; font-size: 10.5px; font-weight: 700;
letter-spacing: .14em; color: var(--warning-deep) /* #B45309 */;
background: rgba(245,158,11,.06); border: 1px dashed rgba(245,158,11,.65);
```

---

## 2. Typography

✅ **Resolved.** Satoshi is self-hosted from the official Fontshare/ITF distribution you
provided (`apps/web/public/fonts/satoshi/Satoshi_Complete/`, free license — see
`.../License/FFL.txt`). Wired at `apps/web/public/fonts/satoshi/satoshi-{400,500,700,900}.woff2`
and declared via real `@font-face` in `packages/ui/src/theme.css`.

### Font stacks (as declared)
- `--font-display` / `--font-ui` / `--font-data` (Console, Landing, and App-light-override): `'Satoshi', system-ui, sans-serif`
- `--font-data` (App, all themes): `'JetBrains Mono', ui-monospace, monospace`
- App dark "Midnight Navy" only: `--font-display:'Bricolage Grotesque'`, `--font-ui:'Schibsted Grotesk'`
- Loaded weights found: Satoshi 400/500/700, Bricolage Grotesque 500–800 (variable), Schibsted Grotesk 400/500/600/700/800, JetBrains Mono 400/500/600

### Type scale (by frequency of use — most common sizes across all 3 files)
| Size | Approx. role |
|---|---|
| 28–40px, weight 700 | Hero / display |
| 26–30px, weight 700 | Section title / H1 |
| 15–20px, weight 600–700 | H2 / subsection |
| 13.5–15px, weight 600–700 | Card title / H3 |
| 12–13px, weight 400–500 | Body / UI text (most common overall) |
| 10–11.5px, weight 500–600 | Label / caption (uppercase, tracked) |
| 11–13px, `font-family: JetBrains Mono` | Data / monospace |

### Line height
`1` (tight UI/labels), `1.5` (body), `1.55–1.65` (paragraph), `1.7` (loose copy)

### Letter spacing
`-.02em` (headings, most common), `-.01em` to `-.045em` (tightened UI text),
`.04em`–`.06em` (uppercase small labels), `.08em`–`.14em` (badges like INTERNAL)

---

## 3. Spacing scale (px, extracted from `gap`/`padding` frequency)
```
2, 4, 6, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 32
```
8px-ish base grid; `gap:12px` and `gap:10px` are the single most common values.

## 4. Border radius scale
```
2px (minimal), 4-5px (micro), 6-8px (buttons/chips), 9-10px (standard controls),
11-14px (cards/panels), 16px (large cards), 20-24px (modals), 999px (pills/badges),
50% (avatars/circular icons)
```
Most-used: `8px` (46×), `9px` (42×), `14px` (25×), `999px` (22×).

## 5. Shadows (verified from `:root`)
| Context | `--shadow` (high) | `--drop` (mid) | `--amb` (low) |
|---|---|---|---|
| App light (Satoshi mode) | `0 20px 48px rgba(24,32,47,.10)` | `0 12px 28px rgba(24,32,47,.07)` | `0 1px 2px rgba(24,32,47,.05)` |
| App dark (Midnight Navy) | `0 32px 80px rgba(5,9,16,.62)` | `0 18px 40px rgba(5,9,16,.5)` | `0 8px 24px rgba(5,9,16,.4)` |
| Console | `0 20px 48px rgba(15,23,42,.12)` | `0 10px 26px -8px rgba(15,23,42,.18)` | `0 1px 2px rgba(15,23,42,.04)` |
| Landing | (same family as Console — light, `rgba(15,23,42,*)`) | | |

Buttons/highlights also use one-off inset+drop combos, e.g.
`inset 0 1px 0 rgba(255,255,255,.9), 0 8px 18px -10px rgba(79,70,229,.5)`.

## 6. Borders / focus rings
- Standard border: `1px solid var(--line)` / `var(--line2)`
- Error border: `var(--bad-bd)` → `rgba(239,68,68,.28)` (light) / `rgba(224,106,94,.34)` (dark)
- Warning border: `rgba(217,160,63,.32)` (dark) / amber equivalents in light
- Focus ring (dark theme): `outline: 2px solid var(--live)`, `outline-offset: 2px`
- Focus ring (light/Satoshi theme, auth & app): `outline: 2px solid #4F46E5`, `outline-offset: 2px`

## 7. Transitions
- Standard easing: `cubic-bezier(.2,.7,.2,1)` — used for transform/box-shadow
- Elastic/expand easing: `cubic-bezier(.16,.84,.3,1)` — height/collapse animations
- Durations cluster at `.12s`–`.24s`; most common `.16s`–`.2s`
- Simple property fades use plain `ease` at `.14s`–`.18s`

## 8. Layout structure
| | App | Console | Landing |
|---|---|---|---|
| Sidebar width (expanded) | `240px` (var `railW`) | not yet confirmed — no `railW`-style var found; needs a closer read while building the shell (Step 2) | n/a (no sidebar) |
| Sidebar width (collapsed) | `64px` | — | n/a |
| Topbar height | `52px` | to confirm in Step 2 | n/a |
| Main content max-width | `1240px` | to confirm | full-width sections |

See `PHASE5_SESSION_NOTES.md` for the build/session narrative (what was
found already built, the App shell rebuild, bugfixes, and each session's
close-out report) — this file stays design tokens only.
