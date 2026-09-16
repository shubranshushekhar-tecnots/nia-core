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

---

## Status update — existing implementation found in the repo

Before writing new code I checked what already exists and found a token layer +
partial screens already built (not by this conversation):

- `packages/ui/src/theme.css` — already has the full verbatim token set for
  Landing/Console (`:root`), the App's Midnight Navy dark theme and its Satoshi/indigo
  light-mode override (`[data-app-theme]`), and the auth screens' theme
  (`[data-auth-theme]`) — matches everything extracted above. Font wiring now points at
  your official Satoshi files.
- `apps/web` Landing page and Auth screens (login/signup/forgot/reset/onboarding) —
  look like genuine pixel-ports already (real copy, exact colors/shadows/radii/keyframes
  from the design), and are left untouched.
- `apps/web` App shell (`Sidebar`/`TopBar`/`AppShell`) and screens (`Home`, `Billing`,
  `Connections`) — this is **older Phase-0 scaffold**, not a pixel port: nav is missing
  Members & roles / Settings / Audit log, Org dashboard and Billing are "coming soon"
  placeholders, icons are generic unicode glyphs rather than the design's actual icon
  set. It also already includes a light/dark theme **toggle** in Settings, which
  contradicts the "skip Midnight Navy for now" decision — flagging so you can decide
  whether to keep or remove that toggle.
- Console (superadmin) — nothing built yet.

## Step 2 — App shell rebuild (done)

Per your answers ("Remove it" / "Yes, rebuild in place"), `Sidebar.tsx`, `TopBar.tsx`,
`AppShell.tsx`, `store.ts` and `styles.ts` were rebuilt in place against the design's
verbatim `NAV` array (`orgdash → home → Projects tree → Platform: connections, members,
audit`), keeping all existing data props / role-gating / Supabase wiring. Notes on
interpretation:

- **Theme toggle removed.** `store.ts`/`AppShell.tsx` no longer carry any theme state;
  the shell is statically `data-om-theme="light"`. Midnight Navy stays defined in
  `theme.css` but unused/unreachable, per "skip it for now."
- **Billing nav** now follows the design's `canBilling: !orgMember` rule exactly
  (`role !== 'member'`) and links to the real `/app/billing` route (which already
  existed). This is separate from `packages/schemas/src/can.ts`'s `billing.view`
  capability (which includes `member`) — that file is a deeper server-side permission
  matrix and was intentionally left untouched; the sidebar rule is purely presentational.
- **Org dashboard / Members & roles / Audit log** are now in the nav (role-gated to
  admin/owner, matching the design), but render as disabled "— soon" items since their
  actual pages are Step 3 work not yet built — same treatment the design itself uses for
  its own placeholder items.
- **Sign-out moved to the TopBar avatar** (direct click → `logout`, tooltip "Sign out"),
  matching the design. The Sidebar's Settings dropdown is temporarily just an email
  display (no theme row, no sign-out) until the full multi-tab Settings page (Personal /
  Workspace / Data) is built in Step 3 — at that point "Settings" should become a real
  link instead of a dropdown.
- **Search** ("Search or run" + ⌘K) now opens the existing (previously orphaned)
  `CommandPalette` stub. **Notifications bell** is a disabled "soon" stub — the design's
  notifications dropdown needs a real data model that doesn't exist yet, so it's out of
  scope for the shell pass.
- Nav "active" highlighting now reflects the real current route (`usePathname`) instead
  of hardcoding Home as active on every page.
- Console sidebar/topbar not started — will confirm exact px when that work begins.

Typecheck and `next build` both pass. Visual verification against the running dev server
was not possible in this session (the `/app` routes require an authenticated session);
worth a manual check in the browser when convenient.

## Bugfix — "create project"/"create workflow" not reflecting in sidebar

Root cause: `createProject`/`createWorkflow` (`apps/web/src/lib/dashboard/actions.ts`)
only called `revalidatePath("/app")`. Since there's no shared layout for `/app/*`, each
of `/app`, `/app/connections`, `/app/billing` fetches its own `projects` list
independently — so creating a project/workflow while on Connections or Billing left that
page's sidebar stale (looked like nothing happened) until navigating elsewhere and back.
Fixed by revalidating all three app-shell paths (`revalidateAppShell()` helper) on every
successful insert. Also fixed a cosmetic bug in `CreateWorkflowDialog.tsx` where the
empty-state em dash was a literal `\u2014` string instead of an escape (`{'\u2014'}`).
No route currently exists for opening a project (`/app/projects/[id]`) or an ETL canvas
inside one — that's unbuilt Step 3 scope, not a regression.

## Phase 5 Session 1 close-out — visual-diff known deltas

Recorded once here (rather than only in chat) so they don't need
re-litigating each session. Live app = `/app/workflows/:id` post-chrome-wrap;
design ref = `designs/Nia Core App.html`'s builder view.

- **Dark mode / `data-om-theme` provenance (resolved, not new debt).** This
  *is* a real, traceable decision — not undocumented. It was raised as an
  open question right here at lines 87–90 ("Needs your input: … do you
  still want this 'Midnight Navy' theme built as a real dark-mode toggle,
  or should I leave it out of scope…") and resolved at lines 212–214
  ("Theme toggle removed … per 'skip it for now'"), which directly quotes
  your answer. `AppShell.tsx`'s own comment (`// App shell is light-only…`)
  reflects that resolution and has been present since the repo's first
  commit (`b5e4f66`) — i.e. the decision predates git history for this
  repo; this file is the only artifact that records the Q&A itself (no
  separate commit message or config documents it). Conclusion: keep
  treating `/app` as light-only; this is settled scope, not a gap.
- No persistent left "Nodes" library panel yet — canvas still uses the
  modal Add-node `PaletteDock`. Pulled forward into Session 2 Task 1 (lands
  with the node-properties-drawer work since both touch canvas layout).
- Node cards lack the design's icon avatars / DATA-ACTION badges / pass-
  status rows — Session 2+ scope, not yet scheduled.
- No zoom controls, no canvas-level Execute/+ buttons, no bottom status
  bar, no floating "Ask or command" bar — none of these were requested for
  Session 1; the "Ask or command" bar is Session 4 (chat-on-canvas) scope.
- Design mock's Run/Run checks buttons render enabled (it's a static mock);
  ours correctly render disabled with a "Checks arrive in Session 3"
  tooltip.
- **Chore (not scheduled this session):** `apps/web/e2e/visual.spec.ts`'s
  `/login` and `/signup` snapshots are pre-existing, unrelated ~1% pixel
  diffs (confirmed via `git log`/`git status` on that spec + its baseline
  snapshots — neither touched by Session 1's canvas work). File a ticket to
  regenerate those two baselines; do not fold into canvas work.

## Phase 5 Session 2 close-out — Task 4 (node drawer / transform editor) verification

Unrelated chat-personal-workspace fix (see `docs/decisions.md`'s test-run
standing rule) landed first and was independently verified end-to-end
(schemas/api/worker/web typecheck+test, RLS probes) before this Task 4
work resumed, per that plan's own "resumes after this fix lands" note.

- **Dark mode:** no change since Session 1 — still settled, light-only
  scope; not revisited this session.
- **`NodeConfigPanel.tsx` / `PaletteDock.tsx`:** both deleted. Superseded
  by `NodeDrawer.tsx` (per-node config panel) and the persistent
  `NodesRail.tsx` (replaces the old modal Add-node dock flagged as
  Session-2-pending in the note above) — confirmed dead via `git log`
  (neither file referenced by any remaining import) before removal, not a
  regression.
- **All 3 shipped connector manifests (mysql/mongodb/supabase) declare
  `operations: ["read"]` only** — confirmed via grep across
  `packages/schemas/src/manifest.ts`/`connectors/*.ts`. The drawer's
  "Locked" write-verb UI has no real fixture to exercise it against; this
  is a genuine coverage gap (not skipped work) until a write-capable
  connector ships.
- **Two real application bugs found and fixed** (not test-authoring
  artifacts): `FilterCondition.field` and `ComputedFieldStep.name` in
  `packages/schemas/src/nodeConfig.ts` were `z.string().min(1)`. Since the
  drawer autosaves on every keystroke, a freshly-added filter condition or
  computed-field step (whose default value is `''` before the user fills
  it in, or before the upstream schema fetch resolves) failed validation
  immediately and silently flipped the node into `unrecognized: true`
  read-only mode — a real, confusing UX bug for any user, not just this
  test suite. Relaxed both to `z.string()`; confirmed via grep neither
  field's `.min(1)` was asserted on in `nodeConfig.test.ts`, and this
  schema isn't wired into any execution path yet (Session 2 is
  editor-only), so there's no runtime-safety regression from relaxing it.
- **Ground-truth/test-race discovery:** the 800ms-debounced single-timer
  autosave (`FlowCanvas.tsx`'s `AUTOSAVE_DELAY_MS`) means a bare
  `getByText('Saved')` check after a rapid sequence of edits can pass on a
  stale flash from an *earlier* save, not the one carrying the latest
  edit — caught via a reload-and-reread assertion that came back with the
  wrong persisted value. Fixed in the two affected tests by waiting on the
  actual graph `PUT` response (`page.waitForResponse`) instead of the
  transient "Saved" text.
- `canvas.spec.ts`: 8/8 passing, confirmed stable across two consecutive
  full runs (`--workers=1`, no flakes).
- New 1440px visual-diff baseline captured:
  `e2e/canvas.spec.ts-snapshots/canvas-rail-drawer-1440-chromium-darwin.png`
  (rail + open node drawer, read-verb state), with a `maxDiffPixels: 50`
  tolerance for the canvas/SVG edge-rendering's normal sub-pixel jitter
  (33px / 0.01% observed between identical back-to-back runs).
