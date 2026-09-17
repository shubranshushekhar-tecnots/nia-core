# TODO

- Chore: 3 stale visual snapshots (`/login`, `/signup`,
  `command-bar-thread-open-1440`) are failing pixel-diffs at ~0.01 ratio
  in `apps/web/test-results` (pre-existing, not a regression from any
  session's work — confirmed via `git log` that none of their baseline
  PNGs or the pages they cover were touched by the sessions that
  reproduced them, most recently Phase 5 Session 5 Block 5's full-battery
  Playwright run). Re-baseline them.
- ~~Chat feature requires an organization — allow individual/personal-workspace
  users~~ — **reconciled and closed with artifacts** (chat.spec.ts 10/1/0,
  chat-smoke exit 0, user-keyed Redis keys captured live). See
  `docs/decisions.md` for the standing rule on what counts as a proven test
  run, and commit `01436a0` for the code + coverage.
- Canvas multi-node selection (shift-click/rubber-band) — not built;
  single-select + @-pins covers chat scope. Revisit for bulk canvas ops
  and Phase 7 ghost-plan selection.
- AI-suggested charts for the destination preview (Phase 5 Session 5,
  Block 1) — not built. Preview currently renders a table plus one
  hand-rolled CSS bar chart for the single "trivially derivable" shape
  (one numeric column + one text label column, see `PreviewTable.tsx`'s
  `AutoChart`). Full AI-suggested charting (LLM picks chart type/columns
  from arbitrary preview result shapes) is deferred; no chart library is
  in the repo yet either (checked `apps/web/package.json`), so this also
  needs a library decision when picked up.
- **Compiler completeness (Phase 6 Block-0 prerequisite)**: explicit
  source entity/table selection, `compilePushdown()`'s FROM gap, and
  multi-transform pushdown chaining — three related gaps, one
  consolidated item. Source nodes persist no entity selection today
  (`SourceDestConfig` has no `entity` field); Phase 5 Session 5's preview
  bridges this with `resolveSourceEntity()` (name-matching inference,
  fails closed on zero/ambiguous matches) but that is preview-only and
  not sufficient for a real ETL run, which cannot infer its source table
  by guessing from mapped field names. Needs: persisted `entity` field on
  `SourceDestConfig`, a drawer picker for it, and migrating
  `checkMappings`/`proposeMapping`/`pushdown.ts` off the flat
  `uniqueFieldNames` union onto that explicit selection. See
  `PHASE5_SESSION_NOTES.md`'s Session 5 Block 1 entry and
  `PHASE5_EXIT.md`'s open risks §8.1 for the full writeup.
