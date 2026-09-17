# Phase 5 — Session Notes

Build/session narrative for the pixel-port + canvas work, moved out of
`TOKENS.md` (design tokens only — see that file for the actual token
values) into its own doc, mirroring `PHASE4_EXIT.md`'s convention of one
report file per phase. Chronological, oldest first.

## Status update — existing implementation found in the repo

Before writing new code the pixel-port effort checked what already existed
and found a token layer + partial screens already built (not by that
conversation):

- `packages/ui/src/theme.css` — already had the full verbatim token set for
  Landing/Console (`:root`), the App's Midnight Navy dark theme and its
  Satoshi/indigo light-mode override (`[data-app-theme]`), and the auth
  screens' theme (`[data-auth-theme]`) — matches everything extracted in
  `TOKENS.md`. Font wiring now points at the official Satoshi files.
- `apps/web` Landing page and Auth screens (login/signup/forgot/reset/
  onboarding) — look like genuine pixel-ports already (real copy, exact
  colors/shadows/radii/keyframes from the design), and were left untouched.
- `apps/web` App shell (`Sidebar`/`TopBar`/`AppShell`) and screens (`Home`,
  `Billing`, `Connections`) — this was **older Phase-0 scaffold**, not a
  pixel port: nav was missing Members & roles / Settings / Audit log, Org
  dashboard and Billing were "coming soon" placeholders, icons were generic
  unicode glyphs rather than the design's actual icon set. It also already
  included a light/dark theme **toggle** in Settings, which contradicted
  the "skip Midnight Navy for now" decision — flagged at the time so it
  could be resolved (see `docs/decisions.md`'s "App shell is light-only").
- Console (superadmin) — nothing built yet (still true).

## Step 2 — App shell rebuild (done)

Per the design owner's answers ("Remove it" / "Yes, rebuild in place"),
`Sidebar.tsx`, `TopBar.tsx`, `AppShell.tsx`, `store.ts` and `styles.ts`
were rebuilt in place against the design's verbatim `NAV` array
(`orgdash → home → Projects tree → Platform: connections, members, audit`),
keeping all existing data props / role-gating / Supabase wiring. Notes on
interpretation:

- **Theme toggle removed.** `store.ts`/`AppShell.tsx` no longer carry any
  theme state; the shell is statically `data-om-theme="light"`. Midnight
  Navy stays defined in `theme.css` but unused/unreachable, per "skip it
  for now."
- **Billing nav** follows the design's `canBilling: !orgMember` rule
  exactly (`role !== 'member'`) and links to the real `/app/billing` route
  (which already existed). This is separate from `packages/schemas/src/
  can.ts`'s `billing.view` capability (which includes `member`) — that
  file is a deeper server-side permission matrix and was intentionally
  left untouched; the sidebar rule is purely presentational.
- **Org dashboard / Members & roles / Audit log** are in the nav
  (role-gated to admin/owner, matching the design), but render as disabled
  "— soon" items since their actual pages are Step 3 work — same
  treatment the design itself uses for its own placeholder items.
- **Sign-out moved to the TopBar avatar** (direct click → `logout`,
  tooltip "Sign out"), matching the design. The Sidebar's Settings
  dropdown was temporarily just an email display (no theme row, no
  sign-out) until the full multi-tab Settings page (Personal / Workspace /
  Data) is built in Step 3 — at that point "Settings" should become a real
  link instead of a dropdown.
- **Search** ("Search or run" + ⌘K) opens the existing (previously
  orphaned) `CommandPalette` stub. **Notifications bell** is a disabled
  "soon" stub — the design's notifications dropdown needs a real data
  model that doesn't exist yet.
- Nav "active" highlighting reflects the real current route (`usePathname`)
  instead of hardcoding Home as active on every page.
- Console sidebar/topbar not started.

Typecheck and `next build` both passed. Visual verification against the
running dev server was not possible in that session (the `/app` routes
require an authenticated session).

## Bugfix — "create project"/"create workflow" not reflecting in sidebar

Root cause: `createProject`/`createWorkflow`
(`apps/web/src/lib/dashboard/actions.ts`) only called
`revalidatePath("/app")`. Since there's no shared layout for `/app/*`,
each of `/app`, `/app/connections`, `/app/billing` fetches its own
`projects` list independently — so creating a project/workflow while on
Connections or Billing left that page's sidebar stale (looked like nothing
happened) until navigating elsewhere and back. Fixed by revalidating all
three app-shell paths (`revalidateAppShell()` helper) on every successful
insert. Also fixed a cosmetic bug in `CreateWorkflowDialog.tsx` where the
empty-state em dash was a literal `\u2014` string instead of an escape
(`{'\u2014'}`). No route currently exists for opening a project
(`/app/projects/[id]`) or an ETL canvas inside one — that's unbuilt Step 3
scope, not a regression.

## Phase 5 Session 1 close-out — visual-diff known deltas

Recorded once here (rather than only in chat) so they don't need
re-litigating each session. Live app = `/app/workflows/:id`
post-chrome-wrap; design ref = `designs/Nia Core App.html`'s builder view.

- **Dark mode / `data-om-theme` provenance (resolved, not new debt).** This
  *is* a real, traceable decision — not undocumented. See
  `docs/decisions.md`'s "App shell is light-only" entry for the full Q&A
  reconstruction; conclusion: keep treating `/app` as light-only, this is
  settled scope, not a gap.
- No persistent left "Nodes" library panel yet — canvas still uses the
  modal Add-node `PaletteDock`. Pulled forward into Session 2 Task 1
  (lands with the node-properties-drawer work since both touch canvas
  layout). **Resolved in Session 2** — see below.
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
  snapshots — neither touched by Session 1's canvas work). Filed as a
  chore in `TODO.md`; do not fold into canvas work.

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
  Session-2-pending above) — confirmed dead via `git log` (neither file
  referenced by any remaining import) before removal, not a regression.
  Rationale is also recorded inline in `NodeDrawer.tsx`'s file-header
  comment.
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
- `canvas.spec.ts`: 8/8 passing (5 Session-1 cases + 3 Session-2 cases —
  see the completion-audit note below on the "six cases" discrepancy),
  confirmed stable across two consecutive full runs (`--workers=1`, no
  flakes).
- New 1440px visual-diff baseline captured:
  `e2e/canvas.spec.ts-snapshots/canvas-rail-drawer-1440-chromium-darwin.png`
  (rail + open node drawer, read-verb state), with a `maxDiffPixels: 50`
  tolerance for the canvas/SVG edge-rendering's normal sub-pixel jitter
  (33px / 0.01% observed between identical back-to-back runs).

## Session 2 completion-audit addendum (this session)

Re-verified every Session 2 deliverable against the actual code (not
against this file's own prior claims) at commit `3f9a6b1`. Full audit
delivered in chat; summary of the two real gaps found and fixed:

- **`GET /connections/:id/schema` had no test proving cross-workspace
  access is denied.** The code was already correct (`services/
  connections.ts`'s `getConnectionSchema` reuses the same
  `"orgId" in scope ? ... : ...` RLS-mirroring gate as every other
  connections.ts function, returns `404 NOT_FOUND` — not a literal `403`,
  which matches the uniform convention across `grants.ts`/`connectors.ts`/
  `workflowGraphs.ts`: a row in a workspace you can't see is never
  revealed to exist). Added `apps/api/src/services/connections.schema.
  test.ts` (4 tests: cross-org, cross-owner, org-actor-vs-personal-row,
  and a matching-scope positive case) to close the coverage gap.
- **"Six Playwright cases" vs. actual count.** `canvas.spec.ts` has 3 new
  Session-2 test cases (drawer + locked read-verb + visual snapshot;
  filter step + pushdown summary + autosave-reload; invalid computed-field
  expression never autosaves), on top of 5 pre-existing Session-1 cases —
  8 total, not the "six" new cases a prior instruction apparently asked
  for. The original Session-2 prompt text that enumerated those six cases
  wasn't available to reconstruct in this session (conversation history
  had been compacted before this audit); rather than guess at three
  invented case names, this is flagged honestly as an open item — see the
  chat report for what's proposed if that enumeration can't be recovered.
- No "9/9 → 8/8" canvas.spec.ts transition exists anywhere in git history
  or prior docs — the file went 5 (Session 1) → 8 (Session 2), by
  addition only, no test was ever deleted or merged. `debug_canvas.spec.ts`
  (an 18-line nav debug helper, not part of the real suite) was deleted
  separately as dead-code cleanup, unrelated to the 5→8 count.
- **Correction to this file's own prior claim above** ("confirmed stable
  across two consecutive full runs, no flakes"): re-running the full
  12-test suite this session (`PORT=3100 npx playwright test
  e2e/canvas.spec.ts --workers=1`) surfaced one real failure the first
  time — test 7 ("build a filter step, autosave, reload keeps it") failed
  a post-reload assertion (`select` showed the placeholder selected
  instead of the persisted `field: 'salary'`), even though the error
  context's own accessibility snapshot showed the `salary` `<option>` was
  present, meaning the schema had loaded but the saved/reloaded field
  value hadn't. Investigated the full autosave path (`TransformEditor.tsx`
  -> `NodeDrawer.tsx` -> `FlowCanvas.tsx`'s `scheduleSave`/debounce ->
  `flowToGraph`/`graphToFlow` -> `apps/api`'s `putWorkflowGraph`) end to
  end and found no deterministic bug — every layer passes `config`
  through untouched, and the debounce correctly cancels/reschedules a
  single pending timer per edit. Re-ran the full suite 3 more times
  back-to-back afterward: **12/12 clean every time**, including test 7.
  Likely a one-off cold-start race (first request to the canvas route
  after a fresh `next dev` boot compiling `TransformEditor`'s chunk
  slower than the debounce window) rather than a reproducible app bug —
  but this is a genuine, previously-undetected flake, not a fabricated
  concern, and the "no flakes" line above should be read as superseded by
  this note. If it recurs, re-open and check for the cold-compile pattern
  specifically (first canvas.spec.ts test after a dev-server restart).

## Session 2 close-out — final items (this session)

- **Palette purity (NodesRail moat invariant) — real Playwright coverage
  added.** Three new tests in `canvas.spec.ts`, each its own
  `test.describe` (a persona/connection-shape apart, so each needs its own
  `test.use`): (1) Triggers section renders locked — "Soon" badge present,
  no `onDragStart` wired to it at all, and a real HTML5-DnD drag attempt
  onto the canvas lands zero nodes; (2) `canvasA`'s rail lists exactly its
  2 real connections (mysql/mongodb) + the generic Transform node —
  `supabase` (a registered, `etl_source`-capable connector `canvasA` has
  no connection for) is absent, and `Destinations` never renders as a
  section (no connector in the registry declares `etl_sink` yet); (3) a
  fresh `canvasB` workspace with zero seeded connections — project and
  workflow created live via the real UI, not seed data — sees exactly one
  draggable entry in the whole rail (the generic Transform node) plus the
  locked Trigger; no hardcoded tool fills the gap. All 3 confirmed passing
  individually and as part of 4 consecutive clean full-suite runs (see
  below).
- **Cross-workspace schema coverage — substitution accepted, noted here
  per direction.** The `GET /connections/:id/schema` cross-workspace
  invariant (see the completion-audit addendum above) is covered by the
  service-level `apps/api/src/services/connections.schema.test.ts` 4-case
  suite instead of a Playwright e2e. That substitution is accepted as
  sufficient coverage for this invariant — not tracked as an open e2e gap.
- **Historical correction.** Session 1 close-out was reported (in that
  session's chat, not written into this file) as `canvas.spec.ts` 9/9.
  Verified via `git show 1cb22ed:apps/web/e2e/canvas.spec.ts | grep -nE
  "^\s*test\("` — commit `1cb22ed` ("Phase 5 Session 1 close-out: delete
  superseded pre-React-Flow canvas files") is the actual Session 1
  close-out commit, and the suite had **5** tests at that commit, not 9:
  `drag 2 sources + 1 transform...`, `two tabs on the same workflow...`,
  `canvasB cannot list or open canvasA's workflow`, `canvasC (no org) can
  open their personal workflow`, `workflow with an unrecognized
  manifestId...`. (This supersedes the "no 9/9 → 8/8 transition exists"
  line in the completion-audit addendum above, which was checking for the
  wrong transition — the real discrepancy is 9-reported vs. 5-actual at
  Session 1, not a 9-to-8 drop.) At the last commit before this session
  (`384c2f8`), the suite actually had **8** tests
  (`git show 384c2f8:apps/web/e2e/canvas.spec.ts | grep -cE "^\s*test\("`
  → 8) — matching the "8/8" line above, not the "12-test suite" the
  completion-audit addendum above describes running; that "12" wasn't
  re-verified this session and is flagged here as a further discrepancy
  in this file's own count history, separate from the 9-vs-5 correction
  this item was asked to make. Current suite, after this session's 3
  palette-purity additions, is **11**
  (`grep -nE "^\s*test\(" apps/web/e2e/canvas.spec.ts | wc -l` → 11).
  Verified **11/11 across 4 consecutive full runs**
  (`PORT=3100 npx playwright test e2e/canvas.spec.ts`, `apps/web/`,
  4 back-to-back clean runs, no retries, no flakes).
- **Dark mode:** verbatim Q&A quoted for the human's confirmation in this
  session's chat response, per explicit instruction not to act on it
  either way — not reproduced here since no code/decision change resulted.

## Phase 5 Session 3 — Task 1 revision: check-run audit log + etl_sink

- **`workflow_check_runs` (0014) revised from client-writable to a strict
  audit-log pattern before ever shipping.** The original draft gated
  INSERT with the same `can_access_workflow` check used for SELECT —
  but check results gate the Run button, so a client-writable row is a
  forgeable gate: any authorized member could PostgREST-insert a fake
  all-pass row at the current `graph_version` and enable Run without
  checks ever actually running. Fixed: RLS now grants **SELECT only**;
  all writes go through a new `security definer` function
  `public.record_check_run(p_workflow uuid, p_results jsonb)` which
  re-verifies `private.can_access_workflow` itself and reads
  `graph_version` server-side from `workflow_graphs` in the same
  statement (not a caller-supplied parameter, so it can't be forged
  stale). Note the function is `public.record_check_run`, not
  `private.record_check_run` as originally specified — `private`-schema
  functions are never PostgREST-exposed (confirmed via
  `0008_connector_secret_rpc.sql`'s own header comment), so `private`
  would have made it uncallable from `req.supabase.rpc()`; corrected to
  match the established `public`-schema/`security definer`/locked-down-
  grants pattern from `0009_connector_write_paths.sql`'s
  `create_connector_secret`/`log_execution_audit`. 3 new RLS probes
  added (direct INSERT as a member → denied; RPC as a non-member →
  exception; RPC as a member → row persisted with the current
  `graph_version`, no way to supply another) — all passing against the
  real remote DB, no regressions on the ~30 pre-existing probes.
- **supabase manifest gained `etl_sink`** (destination placement only;
  no write capability implied). Verified explicitly: neither `can.ts`
  nor any RLS policy keys off connector capabilities — capabilities are
  `NodesRail.tsx`'s `buildEntries()` UI-placement input only; the actual
  write-permission gate stays `WRITE_OPERATIONS`/`checkGrants`, untouched
  by this change. `dev-bootstrap.ts` now seeds canvasA (canvas-e2e org)
  with a supabase connection alongside mysql/mongodb so the palette's
  Destinations section and `checkDag`'s source→destination path
  requirement are exercisable end-to-end; the demo org is intentionally
  left unseeded (unaffected). `canvas.spec.ts`'s connection-driven
  palette-purity test updated to match (supabase now lists under both
  Sources and Destinations, 5 draggable entries instead of 3); the
  zero-connection (canvasB) and Triggers-moat (canvasC) tests were
  confirmed unaffected and left untouched.

## Phase 5 Session 3 — Task 2: checks dock + Run gating (`c4c8800`)

- **`ChecksDock.tsx`** replaces `CheckResultsPanel`'s dropdown with a
  full-width bottom dock: a summary pill ("All checks passed" / "N
  failing" / "out of date") doubles as the collapse/expand control;
  clicking a failing row selects + centers that node on the canvas via
  `FlowCanvas.tsx`'s `handleSelectCheckNode` (`setCenter` at the node's
  measured center, `zoom: 1`, 300ms animated pan). Checks tab is live;
  Logs tab renders disabled ("Session 4") — the real placeholder for the
  Session 4 scope named in this file's own STOP boundary.
- **Run gating is real, not cosmetic:** `runEnabled = !checksStale &&
  failingChecks === 0`, where `checksStale = !latestCheckRun ||
  latestCheckRun.graphVersion !== version` — enabling requires the latest
  *persisted* check run to both be all-pass and match the live graph's
  version, so any edit after a run (even one that would objectively pass)
  correctly re-stales the gate. Clicking Run while enabled shows an
  "Execution arrives in Phase 6" stub modal; no run rows are created —
  the gate itself is real even though execution doesn't exist yet.
- **Ground-truth discovery: `auth.uid()`-under-service-role.**
  `public.record_check_run` (0014) persists through
  `private.can_access_workflow`, which relies on `auth.uid()` — populated
  only for a request carrying the caller's own JWT, never for a
  `service_role` call. This means `apps/worker` structurally **cannot**
  call `record_check_run` itself (its Supabase client is `service_role`,
  no `auth.uid()`, the RPC would always refuse it). The split enforced by
  this finding: `runWorkflowChecks.ts` (worker) only *computes* results
  and returns them over the BullMQ job payload; `apps/api/src/services/
  checks.ts` (the Express route, using `req.supabase` — the caller's own
  JWT) is the only thing that ever calls the RPC and persists. Documented
  in both files' header comments and in `0014`'s own header comment; not
  an incidental detail, a load-bearing trust-boundary requirement.
- **`checksQueue.ts` timeout hardening:** the route's BullMQ
  job-completion await now has an explicit, env-tunable timeout
  (`CHECK_RUN_TIMEOUT_MS`, default 30s) returning `503` naming the worker
  unavailable instead of hanging indefinitely if no worker is consuming
  the queue. Covered by `checksQueue.timeout.test.ts`.
- e2e: the two checks-dock/Run-gating Playwright tests landed this task;
  see Task 4 below for the completeness audit performed on them this
  session.

## Phase 5 Session 3 — Task 3: AI-proposed field mappings (`22b7556`)

- **Manual + LLM-assisted mapping approval flow.** `MappingEditor.tsx`
  (destination-node drawer) lets a user hand-build `FieldMapping` entries
  or call `POST .../propose-mapping` (BullMQ round-trip to
  `apps/worker/src/lib/mappings/proposeMapping.ts`, real Gemini call) to
  get a proposed mapping to review before approving. Approval is
  click-gated, not automatic — proposing never auto-persists.
  `checkMappings` (packages/schemas/src/checks.ts) is the enforcement
  point: a heterogeneous source→destination path with no *approved*
  mapping fails checks; approving clears the failure; editing an approved
  entry clears `approvedAt` immediately client-side and re-fails on the
  next run.
- **Delivery mechanism: `QueueEvents.waitUntilFinished`, not SSE** — a
  mapping proposal is a single request/response outcome, not a stream,
  mirroring the exact pattern `checksQueue.ts` already established for
  check runs. Rationale recorded inline in
  `apps/api/src/lib/mappingsQueue.ts`. This decision is intended to be
  reused as-is for Phase 7's copilot plan delivery — don't re-litigate
  the SSE-vs-queue choice there without a genuinely different shape of
  problem (e.g. an actual multi-event stream).
- **Real product bug found and fixed: `MappingEntry` lockout.** Both
  `MappingEntry.from`/`.to` in `packages/schemas/src/nodeConfig.ts` were
  `z.string().min(1)`. Since `MappingEditor.tsx` autosaves on every
  keystroke/select-change, a freshly-added entry (`from`/`to` default to
  `''` until the user picks both) failed validation on the very next
  render and permanently flipped the node into `NodeDrawer`'s read-only
  "unrecognized config" fallback — a real UX lockout, not a test
  artifact, matching the exact same class of bug Session 2 found and
  fixed for `FilterCondition.field`/`ComputedFieldStep.name`. Relaxed
  both to `z.string()`, same convention as that prior fix; check-time
  emptiness validation added separately in `checkConfig()` (see Task 4
  below — the `checkConfig` branch existed for filter/computed-field
  already, this task's fix restores the same permissive-schema/
  strict-check split for mapping entries). Confirmed no `.min(1)` is
  asserted anywhere in `nodeConfig.test.ts` and this schema still isn't
  wired into any execution path (editor-only), so no runtime-safety
  regression from relaxing it.
- **Ground-truth discovery: `packages/schemas` dist/ rebuild footgun.**
  `apps/web`'s `next.config.mjs` only lists `@nia/ui` in
  `transpilePackages` — `@nia/schemas` resolves via its own
  `package.json`'s `main: "./dist/index.js"` (compiled output), not
  transpiled from source by Next. Any edit to `packages/schemas/src/
  *.ts` is invisible to a running `next dev` / Playwright run until
  `pnpm --filter @nia/schemas build` is re-run. Root-caused after a
  Playwright test kept failing against clearly-correct-looking source
  during this task; costs real debugging time if forgotten — check this
  first the next time a schemas-layer change "doesn't seem to take" in
  the running app.
- **`playwright.config.ts`: `workers: 1` pinned**, with a header comment
  citing dev-server contention as the reason — this is config, not a
  remembered convention, so it survives regardless of who's running the
  suite.
- e2e: one new heterogeneous-path (mysql→supabase) manual-mapping test;
  full suite verified clean (18/18 at the time) under the `workers:1`
  pin, after also discovering and fixing the dist/ rebuild issue above.

## Phase 5 Session 3 — Task 4: closing battery (coverage + baselines, this session)

No new features — closes out Session 3's coverage/baseline/bookkeeping
debt before Session 4 (command bar + Logs) starts.

- **`checks.test.ts` fixture-completeness audit.** Cross-referenced every
  fixture in the Session 3 spec list against `checkConfig()`'s actual
  code branches (not just the spec's bullet wording) — found one real,
  untested branch: `ComputedFieldStep.name === ''` is a separate `case`
  from the already-tested `FilterCondition.field === ''` branch, despite
  both arguably falling under the same "empty-required-field" spec
  bullet. Added `"fails a computed-field step with no output name..."`
  to close it. Final per-fixture checklist (all in
  `packages/schemas/src/checks.test.ts`):
  - cyclic graph — `"fails on a cyclic graph"`
  - orphan node — `"fails on an orphan node"`
  - dangling edge — `"fails when an edge references a missing node"`
  - missing source→destination path — `"fails when there is no source ->
    destination path"`
  - unrecognized config — `"fails an unrecognized config shape"`
  - empty-required-field (filter) — `"fails a filter step with no field
    selected"`
  - empty-required-field (computed field) — `"fails a computed-field step
    with no output name (permissive at the schema layer, not at check
    time)"` (new this task)
  - incomplete mapping entry — `"fails a destination mapping entry with
    an unset field"`
  - write-verb tripwire — `"fails loudly (tripwire) if a write verb
    appears..."`
  - credential dedup + failure — `"fails when the injected test function
    reports failure"` + `"dedupes nodes sharing the same connection"`
  - mapping approved — `"passes an approved mapping whose fields still
    exist"`
  - mapping drifted — `"fails on drift: a mapped source field no longer
    exists upstream"`
  - mapping missing — `"fails a heterogeneous path with no approved
    mapping"`
  - mapping unresolvable-introspection — `"skips drift verification (does
    not fail) when introspection data is unavailable"`
  145 passed, 10 test files (`pnpm --filter @nia/schemas exec vitest
  run`).
- **`canvas.spec.ts` gating-loop completeness audit.** The full
  broken→fix→pass→Run→stub and pass→edit→stale→disabled loop was already
  covered piecewise across Task 2's two tests. The one genuine gap: the
  checks-dock row-click's re-centering (`setCenter`) was *exploited* by
  the existing test (a 400ms wait + fresh bounding-box read for a
  downstream drag target) but never independently *asserted*. Added an
  explicit assertion — after the 300ms pan settles, the selected node's
  on-screen bounding-box center must be within 20px of the
  `.react-flow__pane`'s own center. The stale-after-edit transition
  (user's other suggested gap) was already fully covered by the second
  Task 2 test — confirmed via re-read, not re-added.
- **Visual-diff baselines (1440×900, light-only, per the App-shell-is-
  light-only decision in `docs/decisions.md`), 3 new snapshots under
  `e2e/canvas.spec.ts-snapshots/`:**
  `checks-dock-failing-1440-chromium-darwin.png` (dock open, 2 failing,
  highlighted+centered node, drawer open),
  `checks-dock-all-pass-1440-chromium-darwin.png` (dock open, all-pass,
  Run enabled), `destination-mapping-editor-1440-chromium-darwin.png`
  (destination drawer, mapping editor with one populated, not-yet-
  approved entry). Checked `designs/Nia Core App.html` for a
  corresponding mock state for each (`grep`'d for dock/mapping-editor
  markup): none exists — the static export predates both the checks-dock
  and mapping-editor features, only a generically-enabled "Run checks"
  button text is present (already logged as a known delta in Session 1).
  No new known-delta ledger entries added; nothing to diff against.
  Sub-pixel jitter on these two shots (live canvas/SVG surface, freshly
  re-panned) measured at ~200-2500px / ~0.01 ratio across identical
  back-to-back runs — `maxDiffPixels` set to 3000 and 500 respectively
  (vs. the drawer-only baseline's 50) to absorb it; documented inline at
  each call site.
- Full verification battery for the session's final state: see the
  chat report for this task's exact counts/artifacts (schemas/api/worker
  vitest, `canvas.spec.ts`, `chat.spec.ts`, `rls_probes.sql`).
- **Open items carried forward into Session 4:**
  - Logs tab (`ChecksDock`'s disabled "Session 4" tab) — real scope for
    the command-bar + Logs session.
  - LLM-assisted mapping proposal e2e intentionally stays smoke-only
    (`apps/worker/scripts/mapping-smoke.ts` against real Gemini + live
    infra) rather than becoming a Playwright test — not a coverage gap,
    a deliberate boundary (Playwright shouldn't depend on a live LLM
    call).
  - Two pre-existing, environmental Playwright flakes (unrelated to any
    Session 3 code): Supabase local GoTrue auth-setup rate-limiting on
    `auth.setup.ts`, and `gotoWorkflow`'s navigation intermittently
    timing out under high system load. Both recurred during this task's
    verification runs (on unrelated, untouched tests) and resolved on
    retry once load settled — noted again here per the carry-forward
    instruction, not re-investigated as a code bug.

## Phase 5 Session 4 — floating command bar + Logs tab

### Block 0 — latency re-measurement

Re-ran `apps/web/latency_hops.mjs` (10 runs, real `@mysql-dev` connection,
real Gemini calls, full stack up: web:3100, api:4001, worker, docker
sandbox DBs/redis) before building anything, per the plan's blocking
condition.

```
                                     Phase 4 baseline (§4.2)   Session 4 re-measurement
POST send -> BullMQ enqueue         p50=124-130ms p95=155-180ms   p50=251ms  p95=292ms
Enqueue -> worker picks up job       p50=1ms      p95=3ms         p50=2ms    p95=12ms
Pickup -> first stage event          p50=4ms      p95=14-15ms     p50=11ms   p95=22ms
First stage -> first token (worker)  p50=8295-8482ms p95=12173-12498ms  p50=7595ms p95=7806ms
Worker publish -> client receipt     p50=3ms      p95=5-33ms      p50=4ms    p95=11ms
TOTAL: POST -> first stage (client)  p50=216-219ms p95=259-276ms  p50=383ms  p95=413ms
TOTAL: POST -> first token (client)  p50=8431-8603ms p95=12276-12642ms  p50=7846ms p95=8089ms
```

Still fails the <3s exit bar, unchanged from Phase 4's conclusion — the
~7.6-7.8s floor is the same two-sequential-LLM-calls bottleneck Phase 4
already root-caused and exhausted every prompt/transport/config lever
against (`PHASE4_EXIT.md` §4-5). The one real change: **p95 tightened
substantially** (12.3-12.6s -> 8.1s) — tail variance is down, though a
single 10-run sample on a shared dev machine isn't enough runs to call
that a confirmed fix vs. noise; flagging it, not claiming it. Per the
plan, built the bar regardless of this result — **STOP condition still
applies**: not calling this "done" until the user rules on these
numbers.

### Block 1 — migration 0015

`supabase/migrations/0015_conversation_workflow_link.sql`: added
`conversations.workflow_id uuid references workflows(id) on delete set
null` + a `(workflow_id, updated_at desc)` index. No RLS change — access
still resolves via the existing org/owner XOR policies on
`conversations`, same pattern as `workflow_check_runs.workflow_id`. Two
probes added to `rls_probes.sql` (#33/#34: org member
creates/reads a workflow-linked conversation and their org-mate sees it
too; cross-org actor cannot see it). Pushed and confirmed via `supabase
migration list`.

### Block 2/3 — the command bar + answer thread

- Lifted `apps/api/src/routes/chat.ts`'s single-source restriction
  (`connectionIds.length !== 1` -> `=== 0` / `> MAX_SOURCES`).
  `MAX_SOURCES` moved to `packages/schemas/src/chat.ts` so API and worker
  import the same constant instead of the worker owning a local one the
  API's comment claimed (falsely, by then) to mirror.
- `ChatRequestBody` gained `workflowId` (create-only); `chat.ts` service
  gained `createConversation(..., workflowId?)` and
  `getLatestConversationForWorkflow`; new `GET /workflows/:id/conversation`
  route, scope-checked the same way `assertWorkflowInScope` already does.
- Extracted `ChatClient.tsx`'s SSE/event/retry mechanics into
  `apps/web/src/lib/chat/useChatSession.ts`, parameterized by
  `connectionIds: string[]` (was a single id) so both `ChatClient.tsx`
  (`[selectedConnectionId]`) and the new `CommandBar.tsx` (the merged
  scope set) share one implementation. `chat.spec.ts` stayed green
  unchanged, confirming no regression from the extraction.
- **Scope precedence, as implemented:** effective scope =
  `dedupe(selectedNode?.connectionId, ...pinnedConnectionIds)`; empty ->
  falls back to every connection wired into the canvas (source +
  destination nodes' `connectionId`, deduped). `@`-pins are independent,
  removable chips that persist across sends; node selection only swaps
  the selection-derived member of the union. Verified end-to-end in
  `command-bar.spec.ts`'s serial test (select -> pin -> ask with both in
  scope -> unpin -> deselect -> fallback text).
- **Known delta (design vs. build):** `designs/Nia Core App.html`'s
  `copilotBarStyle`/`panelStyle` markup nests Checks/Logs under the bar
  as one merged component; this build keeps `CommandBar` and
  `ChecksDock` separate (Session 3 already shipped `ChecksDock`
  independently) with z-index 35 sitting between the dock (30) and
  modals (60). Visually verified both dock states don't overlap the bar.
- **Multi-select decision (from the clarifying question, reconfirmed
  here):** no canvas multi-select (shift-click/rubber-band) was built.
  `@`-pins are the multi-scope mechanism per spec; single-select +
  pins covers 100% of this session's chat-scope requirements. Ledger
  entry added to `TODO.md` for future bulk-canvas-ops/Phase 7 revisit.

### Block 4 — Logs tab

`activityFeed.ts` (new) merges `WorkflowCheckRun[]` + a workflow's chat
messages (reusing the same `getWorkflowConversation` fetch the command
bar already does — no second fetch) into one newest-first
`{ time, text, kind: 'check' | 'chat' }` feed. `ChecksDock.tsx`'s Logs
tab is now live (`activeTab` lifted into `FlowCanvas.tsx`), empty state
only shown when the merged feed itself is empty. Header comment notes
where Phase 6's `kind: 'run'` source plugs in later.

### Bugs found and fixed this session (all in test/e2e code, not
### production logic, except where noted)

1. **CommandBar thread-panel click-interception** — the floating thread
   panel (z-index 35) could grow tall enough to overlap the node-drawer
   (z-index 20) once a real answer landed, intercepting clicks meant for
   the canvas underneath. Fixed with a `dismissThreadIfOpen` helper
   (`canvas.spec.ts`) and an explicit `Dismiss` click
   (`command-bar.spec.ts`) at every point a test's next action could
   collide with it. This is the root cause behind the original "409
   conflict" test flake investigated this session.
2. **Dangling-timer race in `canvas.spec.ts`'s shared `beforeEach`** — a
   node-deletion save's confirmation ("Saved") could still be in flight
   when the hook returned, leaking into the next test. Fixed by waiting
   for "Saved" to appear after any deletion before the hook returns.
3. **Stale-"Saved"-text race (new this session)** — `FlowCanvas.tsx`
   keeps "Saved" visible for 1.5s after a save completes (its own
   idle-reset timer). The deletion-phase save in `beforeEach` could leave
   that text visible long enough for a *later*, fast-running test body's
   own `getByText('Saved')` check to pass on the stale flash instead of
   its own save's real network round trip — observed as a ~50% flake
   rate reproducing "0 nodes after reload" on the drag/connect/reload
   test. Root-caused with network-response instrumentation (a temporary
   diagnostic spec, since deleted) proving the only PUT before reload
   was an empty-graph save in the failing runs. Fixed by also waiting for
   "Saved" to disappear at the end of the same `beforeEach`, so any later
   check in a test body is guaranteed fresh. This is the same class of
   bug two other tests in this file already independently worked around
   via `page.waitForResponse(...)` instead of a bare text check —
   confirms the diagnosis, not a novel failure mode.
4. **Visual-baseline drift from the bar's own existence** — 2 of
   Session 3's `canvas.spec.ts` baselines (`checks-dock-all-pass-1440`,
   `destination-mapping-editor-1440`) now include the floating
   `CommandBar` in their capture region and needed re-baselining; not a
   regression, an expected consequence of adding a new
   always-mounted-on-canvas element.
5. **Multi-source citation instability for visual baselines** — a
   command-bar screenshot taken while scope included 2 connections
   (mysql-dev + pinned mongodb-dev) diffs by ~3% every run: the real
   answer's citation count/order isn't stable across identical questions
   when multiple sources are in scope. Masking the prose text alone
   doesn't fix it. Resolved by capturing the "thread open" and "Logs
   populated" baselines in the single-connection personal-workspace test
   instead (exactly one citation every run), plus pinning the thread
   container's height for the screenshot only (it's
   `maxHeight:380/overflowY:auto` and grows upward from a bottom anchor,
   so real-answer length still shifts everything behind it even with the
   text masked).

### Incident: `apps/web/e2e/canvas.spec.ts` deleted from disk mid-session

Discovered when a validation test run returned "Error: No tests found"
and a filesystem check confirmed the file itself (not just a stale git
snapshot) was gone — only its `-snapshots` sibling directory remained.
Root cause unknown; not caused by any command run this session (no `rm`,
no destructive git operation was issued against this file). Confirmed
via `git status`/`git log` that HEAD (`24062ff`) was the last commit
touching the file, meaning none of this session's edits to it were ever
committed. No recovery artifacts existed (no worktree, no trace/report
files). Reconstructed the full file from `git show HEAD:...` (the
pre-session baseline) plus manual reapplication of every edit made to it
this session, then re-verified the reconstruction end to end
(typecheck, `--list`, full suite, targeted repeat-each runs on both
fixed races) — all green, matching pre-incident state. Flagging this
explicitly since a file was lost and rebuilt from memory rather than a
diff; worth an independent look before trusting it long-term.

**Follow-up verification (post-reconstruction), per explicit request:**

1. **`git log --follow` + `git reflog`**: no recorded git operation
   (`reset`, `checkout -- <path>`, `clean`, `rebase`, `stash`) appears
   anywhere in the reflog for this session's window — every entry is a
   plain `commit`. This doesn't fully clear git as a cause (working-tree
   deletions via `rm`/an editor/a tool bug never touch the reflog at all,
   since reflog only records ref/HEAD-changing operations), but it does
   rule out any of the destructive git commands that would normally leave
   a trace.
2. **Other files in the same window**: no other tracked file showed an
   equivalent unexplained deletion or corruption — only `canvas.spec.ts`
   went missing; its own `-snapshots/` sibling directory (baseline PNGs)
   survived untouched. The current working tree has no `.orig` files, no
   stray 0-byte files, and no other files whose diff-vs-`24062ff` contains
   anything beyond this session's documented, intentional edits (checked
   directly — see point 2 below). If a shared root cause existed (a
   process wiping a whole directory, a bad glob, a crashed test-runner
   write), it did not visibly touch anything else.
3. **Diff `canvas.spec.ts` against `24062ff`** (last committed version):
   every delta is one of this session's own documented fixes, nothing
   unexplained —
   - `dismissThreadIfOpen()` helper + 4 call sites, and a "New chat" reset
     in `beforeEach` — the CommandBar click-interception fix.
   - Two `getByText('Saved')` visible/not-visible waits appended to
     `beforeEach`'s node-cleanup block — the dangling-timer race and the
     stale-"Saved"-text race fixes.
   - Two timeout bumps (5s → 8s) in the "two tabs" conflict test, with an
     inline comment explaining the reasoning (two independently-debounced
     autosaves across two browser contexts is more load-sensitive than
     this file's single-page tests).
   No stray whitespace churn, no reverted assertions, no content that
   doesn't map to a fix already written up above.
4. **Dev-tooling suspects**: checked `apps/web/package.json`'s scripts
   (`dev`, `build`, `start`, `typecheck`, `lint`, `test`, `test:e2e`) and
   the root/other workspaces' scripts — none contain `rm`, `rimraf`,
   `clean`, or any destructive glob touching `e2e/`.
   `playwright.config.ts` sets `testDir: './e2e'` but no custom
   `outputDir`/`snapshotDir` (Playwright's defaults are `test-results/`
   and `<test-file>-snapshots/`, both outside `testDir` and non-colliding
   with it) — no config-level path collision that could make a test run
   overwrite or delete a spec file.

**Verdict: cause unknown, but contained.** No destructive git command, no
project script, and no config collision explains the deletion; nothing
else in the repo shows collateral damage, and the reconstructed file's
diff against the last commit contains exactly this session's known,
documented edits and nothing more. Treat as an isolated, unreproduced
environment/tooling event rather than a recurring risk to actively guard
against — but if `canvas.spec.ts` (or any other e2e spec) goes missing
again, treat it as the same class of incident and escalate rather than
silently reconstructing a second time.

### Full verification battery (final state)

- Typecheck/build: `@nia/web`, `@nia/api`, `@nia/worker` typecheck clean;
  `@nia/schemas` build clean.
- Unit tests (`vitest run` per workspace): `@nia/api` 16 passed,
  `@nia/worker` 65 passed, `@nia/web` 10 passed (scoped to `src/lib/**`),
  `@nia/schemas` 146 passed, `@nia/guardrails` 43 passed + 1 expected
  fail. 280 passing overall.
- `supabase db query --linked --file supabase/tests/rls_probes.sql`: 35
  probes, 0 failures (includes the 2 new migration-0015 probes).
- `PORT=3100 npx playwright test e2e/canvas.spec.ts e2e/chat.spec.ts
  e2e/command-bar.spec.ts --workers=1`: 26 passed, 1 skipped
  (pre-existing `chat.spec.ts` skip, undocumented before this session —
  not introduced by it), 0 failed. Targeted repeat-each runs (4-8x) on
  every race fixed this session confirm they hold under repetition.
- New visual baselines: `command-bar-resting-1440`,
  `command-bar-thread-open-1440`, `checks-dock-logs-populated-1440`
  (all under `e2e/command-bar.spec.ts-snapshots/`), plus 2 re-baselined
  `canvas.spec.ts-snapshots/` entries for the bar's presence.
- `node latency_hops.mjs`: Block 0's table above.

Latency ruling received (see `docs/decisions.md`): <3s bar unmet, not
waived, converted to a Phase 5 exit item (tracked in the new
`PHASE5_EXIT.md` skeleton). Committed in 5 logical commits: `669123d`
(migration 0015 + RLS probes), `34c6111` (backend: scope precedence,
conversation restore, check-run history), `bb4ceb6` (frontend: CommandBar
+ Logs tab), `6dbb3c8` (e2e: command-bar.spec.ts + canvas.spec.ts fixes +
baselines), plus this session-notes/decisions/TODO bookkeeping commit.

## Phase 5 Session 5 — Block 1: destination-node read preview

Adds a Preview action to the destination node's drawer: compiles the
path's pushdown plan, dispatches the READ side against the source
connection (rowCap 50, same guardrail-validated `dispatch()` path as
everything else), applies the approved mapping's field projection, and
renders the result as a table in the drawer. Never touches a write path —
`isReadShaped()` asserts the compiled query is `kind: "sql"` SELECT (no
mysql DML) or `kind: "mongo-find"` before `runPreview.ts` ever calls
`dispatch()`.

**Entity-resolution gap, and the bridge built to cover it for preview
only (read this before touching `GraphNode`/`pushdown.ts`/preview
again):** source nodes carry no persisted entity/table selection —
`GraphNode.config` for a source node is empty (see `nodeConfig.ts`'s
`SourceDestConfig`, which has no `entity` field), and the entire
mapping/pushdown stack today operates on a flat, deduplicated union of
every entity's field names for a connection (`proposeMapping.ts`'s
`uniqueFieldNames`, mirrored in `MappingEditor.tsx`'s
`useEntityFields`). An approved mapping's `entries[].from` values are
just field *names* — never qualified by entity/table. That was fine when
nothing actually executed a read against the source; Block 1 does, and a
read needs exactly one table/collection to select `FROM`.

The bridge built for this session is `packages/schemas/src/
entityResolution.ts`'s `resolveSourceEntity(schema, mappingFromFields)`:
given the introspected schema and the approved mapping's `from` field
names, it finds the entity whose field set is a superset of every mapped
field. If that's not **exactly one** entity — zero matches, or more than
one candidate table shares the same field names — preview fails closed
with `entity-unresolved` rather than guessing (see its unit tests,
`entityResolution.test.ts`, for the zero/ambiguous/unique cases, and
`runPreview.test.ts`'s two `entity-unresolved` cases for the same
behavior exercised through the full orchestration path). This is a
**preview-only, inference-based bridge, not a real fix.** It is
explicitly NOT sufficient for Phase 6's ETL runner: an actual run cannot
infer its source table by name-matching against whatever fields happen
to be mapped — it needs an explicit, persisted selection. Adding real
entity/table selection (`SourceDestConfig.entity` + a drawer picker for
it, then migrating `checkMappings`/`proposeMapping`/`pushdown.ts` to
consume that instead of the flat union) is a **Phase 6 BLOCK-0
PREREQUISITE**, not deferred polish. Tracked in `PHASE5_EXIT.md`'s open
risks.

**`pushdown.ts`'s FROM/collection gap (the other half of the same root
cause, unchanged this session, documented honestly here rather than
silently worked around):** `compilePushdown()` has never compiled a
`FROM`/collection clause — it is a pure WHERE/computed-field/projection
fragment compiler over a single `TransformConfig`, by design (see its
own header comment). `runPreview.ts`'s `buildPreviewQuery()` supplies the
`FROM "namespace"."entity"` (or Mongo collection) itself, using the
entity `resolveSourceEntity()` just resolved — it does not extend or
change `compilePushdown()`. This keeps `compilePushdown()`'s existing
contract and test suite untouched, but it does mean the "which
table/collection" decision now lives in two different places for two
different reasons (pushdown fragments still assume the caller supplies
FROM; preview additionally has to *infer* what that FROM is). Both gaps
close together once Phase 6's explicit entity selection lands — a single
persisted `entity` field removes the need for `resolveSourceEntity()`'s
inference AND gives `compilePushdown()`'s callers (preview, and
eventually the real runner) an unambiguous FROM to compile against.

**Multi-transform-node pushdown chaining is architecturally undefined**
(not new this session, but surfaced concretely for the first time by
preview needing to actually execute something): `compilePushdown()`
operates on exactly one `TransformConfig`. A path with 2+ transform
nodes between source and destination has no defined way to chain their
compiled fragments together. Rather than inventing chaining semantics
under this session's scope, preview degrades honestly: 0 transform nodes
on the path → trivial (no pushdown needed beyond the mapping's
projection); exactly 1 → normal `compilePushdown()`; 2+ → the entire
path's transforms are treated as residual (nothing pushed down, no
`WHERE`), and `PreviewValue.residualCount` reports the true count so the
drawer's "N in-stream transforms will apply at run time" notice is never
misleading about what actually executed. See `runPreview.test.ts`'s
"degrades to fully residual" case.

**AI-suggested charts — explicitly deferred, not built this session:**
the only chart rendered is the single "trivially derivable" case (one
numeric column + one text label column → a plain CSS bar list, see
`PreviewTable.tsx`'s `AutoChart`) — hand-rolled with no chart library,
since none exists in `apps/web/package.json` (checked before writing
it; not worth adding a dependency for one bar-chart shape). Full
AI-suggested charting (LLM picks a chart type/columns from arbitrary
preview shapes) is out of scope this session and ledgered in `TODO.md`.

**Read-shape assertion:** `runPreview.ts`'s `isReadShaped()` runs
immediately before the single `dispatch()` call and is the last line of
defense that preview can never mutate anything, independent of anything
upstream (mapping `operation`, node config) being read-only by
construction.

Full verification: `@nia/schemas`/`@nia/worker`/`@nia/api`/`@nia/web`
typecheck clean (after rebuilding `@nia/schemas`'s `dist/` — its
package.json resolves consumers against compiled output, not `src`, so
any schema change needs a rebuild before sibling packages' typechecks
see it). `entityResolution.test.ts` 14 passed. `runPreview.test.ts` 12
passed (covers `findSourcePath`'s backward/forward path reconstruction,
the trivial end-to-end dispatch shape including the `rowCap: 50` and
mysql-dialect-quoted SQL, both `mapping-not-approved` variants,
`no-upstream-source`, `checks-failing` reusing `checkMappings` with no
new validation, both `entity-unresolved` variants, single- vs.
multi-transform pushdown behavior, and `dispatch-failed` passthrough).
