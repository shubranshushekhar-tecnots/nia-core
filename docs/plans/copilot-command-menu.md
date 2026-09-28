Save this prompt verbatim to docs/plans/copilot-command-menu.md and re-read it if your context is compacted. Read CONVENTIONS.md first. Don't commit.

Goal: rebuild the Copilot "/" menu in apps/web/src/components/canvas/CommandBar.tsx to look and behave like a professional command menu. Reference (from another tool, visual/interaction only): a panel above the input with a scrollable list of rows (icon + command name), the highlighted row shaded, and a tab strip at the bottom: "Commands 24 | Skills | AI Command" (active tab shows a count). Avoid the reference's flaws: no blank labels, no tooltips overlapping the menu, no clipped last row.

Constraint: UI only. No backend, API, schema or Copilot logic changes. Every command ends up as text sent through the existing proposePlan() flow, so propose → preview → apply stays exactly as it is.

Step 0 — Tree must be clean. STOP if dirty.

Step 1 — Design proposal, then STOP for my approval (no code yet):
1. Command list for this product (ETL/workflow canvas). Propose ~12–20, grouped (e.g. Build, Clean, Run, Inspect, Help). For each: name, icon (existing icon set only), one-line description, the prompt template it inserts, and optional argument with placeholder (e.g. /filter <column> <condition>). Only commands the current Copilot can actually handle via proposePlan or existing UI actions — mark any that would need new logic and leave them out.
2. What the three tabs should hold, based on what exists today:
   - Commands: the list above.
   - Skills: propose what fits from existing features (e.g. reusable prompt recipes, recently used commands) — or propose removing/renaming the tab if nothing real backs it.
   - AI Command: free-form prompt suggestions (today's 6 SLASH_SUGGESTIONS, improved).
   Never show a tab with fake or empty content.
3. A layout sketch (ASCII) and the design tokens you'll use from packages/ui/src/theme.css.

Design (decided, apply after approval):
- Opens when "/" starts a token; typing filters by name and description (fuzzy, prefix matches first); shows "No matching commands" when empty.
- Keyboard: ↑/↓ move (wraps), Enter or Tab selects, Esc closes, ←/→ or Ctrl+Tab switch tabs; the highlighted row always scrolls into view; mouse hover highlights, click selects.
- Selecting a command replaces the "/token" with the command's template and places the cursor at the first argument placeholder. Does not auto-send.
- Rows: icon, name, and a muted one-line description on the right (truncated with ellipsis, full text via title attribute). Group headers inside the Commands tab.
- Tab strip at the bottom with counts reflecting the current filter.
- Recently used commands (last 5) at the top of Commands, stored in localStorage (guarded with try/catch).
- Panel: fixed max height, internal scroll, never clipped by the viewport; flips below the input if there's no room above; no tooltips over the panel; works at 390px width.
- Accessibility: role=listbox/option, aria-activedescendant, tabs as role=tablist/tab, visible focus, screen-reader labels.
- "//" (agent-turn path) keeps working exactly as today.

Tests:
- Unit: filtering and ranking, keyboard navigation incl. wrap and tab switching, template insertion and cursor placement, recent-commands storage (incl. storage failure).
- Update apps/web/e2e/command-bar.spec.ts: open with "/", filter, arrow + Enter selection, Esc closes, tab switching, no clipping at 390px.
- Typecheck every package.

Close-out: screenshots at 1440px and 390px, files changed, which images need rebuilding (should be web only). Record decisions in docs/decisions.md. Don't commit.
