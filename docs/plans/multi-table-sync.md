Multi-table sync plan: select several tables (or a whole schema) and move them in one run. Builds on the existing per-table pipeline; each table keeps its own contract, mapping, key, and CleanPlan.
First, save this entire prompt verbatim to docs/plans/multi-table-sync.md, and re-read it if your context is compacted. Move fast; keep tests to exactly the listed ones. Don't commit.

Step 0: Confirm the tree is clean apart from the known landing-page work. STOP otherwise.
Step 1: Short inventory: how a source node stores its table today, how a run is created and executed, and how run status reaches the UI.

Part 1: Selection
- The source node can select multiple tables, or a whole schema. Tables that can't be synced yet (no single-column primary key, views) are shown as unavailable with the reason, and never fail the run.
- Destination names default to the source names. The user can set a target schema or a name prefix.

Part 2: Execution
- One parent run with one child run per table, using the existing runEtl path unchanged. Children run with a configurable concurrency limit (default 3) so the source isn't overloaded.
- Each table gets its own contract (auto-created via Schema Bridge), deterministic name mapping, primary-key upsert, staging, and apply.
- Apply mode:
  - Per table (the default): each table commits on its own, and the summary lists any failures.
  - All-or-nothing: stage every table first, then apply all of them in one destination transaction, in foreign-key dependency order when the destination tables have foreign keys. Only available when every table goes to the same destination database.
- A failed table can be retried on its own, without rerunning the others.

Part 3: Cleaning
- "Propose cleaning" can run across all selected tables at once: route and propose per table, then the user reviews each table before applying. Each applied table gets its own CleanPlan.

Part 4: UI
- The canvas shows one source → destination pair with a table-count badge. Clicking it opens the per-table list: status, rows, quarantine count, and each table's own mapping and contract preview.
- The run view shows the parent summary, with a row per table.

Tests (exactly these)
- Unit: a table without a primary key is marked unavailable and doesn't fail the run.
- Unit: all-or-nothing apply orders tables by foreign-key dependency.
- One smoke: 3 tables from the sandbox postgres into new tables in a sandbox postgres destination, one table with a quarantined row. Assert per-table counts, and that the other tables still applied.
- Typecheck every package.

Close: a docs/decisions.md entry and MULTI_TABLE_SYNC_EXIT.md.
Output: inventory findings, deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.
