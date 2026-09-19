# Decisions

## API auth: Bearer is the default; cookies are the streaming-route exception

Bearer auth (`apps/api/src/middleware/auth.ts`'s `requireAuth`) is the
default for every API route — the client reads the Supabase access token
and sends it as an `Authorization: Bearer <token>` header, which
`requireAuth` validates via `supabase.auth.getUser(token)`. Cookie auth
(`apps/api/src/middleware/cookieAuth.ts`'s `requireCookieAuth`) exists
solely for the chat routes' `EventSource`-based streaming
(`GET /chat/stream`), because `EventSource` cannot set custom request
headers, so there's no way for it to carry a bearer token; it instead
relies on the same httpOnly Supabase session cookies apps/web's Server
Components already read, validated the same way via
`supabase.auth.getUser()` (never `getSession()`, so an expired/forged
cookie is rejected server-side rather than trusted at face value). Both
middlewares are otherwise identical in shape (same `AppError` failure
path, same `req.supabase`/`req.authUser` contract) — the only difference
is where the token comes from. Any new streaming route (SSE/EventSource)
uses `requireCookieAuth`; every other route uses `requireAuth`.

## App shell is light-only — a decision, not theme debt

`AppShell.tsx`'s `// App shell is light-only (matches the design — the
Midnight Navy dark theme is scoped in packages/ui/src/theme.css but
intentionally not wired up as a user-facing toggle here)` comment reflects
a real, traceable decision, not an unfinished gap. `TOKENS.md`'s "Phase 5
Session 1 close-out" section reconstructs the Q&A: raised as an open
question ("do you still want this 'Midnight Navy' theme built as a real
dark-mode toggle, or should I leave it out of scope?"), answered "skip it
for now," and the AppShell comment has reflected that resolution since the
repo's first commit (`b5e4f66`). Contrast with `AuthShell.tsx`, which
deliberately kept its light/dark toggle — the app shell's lack of one is
the intentional asymmetry. Do not describe `/app`'s light-only state as
theme debt or an oversight; it's settled scope.

## App shell dark mode: deferred to backlog (Session 3 reaffirmation)

Recorded verbatim per the Session 3 kickoff decision: "App shell is
light-only for v1; Midnight Navy dark theme deferred to backlog until a
screen requires it." This reaffirms, rather than reopens, the "App shell is
light-only — a decision, not theme debt" entry above — no code change
accompanies this entry; `AppShell.tsx` was already light-only and stays
that way.

## Accent is indigo; the copper `--ign` token is a separate, unaudited concern

Recorded verbatim: "Accent is the design file's indigo family; the older
copper `--ign` token audit is superseded. CI greps updated accordingly —
copper/#C98757 no longer enforced, indigo no longer banned."

`TOKENS.md` already documents these as two distinct tokens, not competing
choices for the same role: `--primary`/`--acc` (`#4F46E5`, indigo) is the
general UI accent used across Landing/Console/App-light and Auth; `--live`/
`--acc-solid` (`#C98757`, copper) is a narrower, semantic "flow/ETL node
status" color scoped to the automation canvas, unrelated to the page-wide
accent role. This decision confirms indigo as the accent and retires any
open question about auditing/enforcing copper as an alternative
general-accent choice — it does not remove `--ign`/`--live` from
`theme.css`, since that token still serves its original canvas-node-status
purpose.

Note: no CI script, lint rule, or `.github/workflows` entry in this repo
currently greps for or enforces either color (checked `package.json`
scripts, `scripts/`, and `.github/workflows/` — none exist). "CI greps
updated accordingly" has no concrete mechanism to update; if a real
enforcement script is added later, it should allow `--ign`/`#C98757` in
`theme.css`'s node-status block and treat indigo (`#4F46E5`/`--primary`) as
the sanctioned page-wide accent, not a banned color.

## Standing rule: a test-run claim must name its artifact

Any report claiming a test suite, smoke script, or e2e run passed (or
failed) must cite the artifact that proves it — a Playwright report/trace
path, a log file, a `TaskOutput`/terminal transcript, or a commit hash
that includes the coverage. A claim with no named artifact does not count
as a run; treat it as unverified and re-run it before relying on it. (This
rule exists because a prior session reported the personal-chat e2e suite
and chat-smoke's personal case as already run and green with no artifact
ever produced — the claim was false; see commit `01436a0` and the
reconciliation in the personal-chat TODO.md entry for the real, re-run
proof.)

## Chat first-token latency: <3s exit bar unmet, not waived — converted to a Phase 5 exit item

Recorded verbatim per the ruling on Session 4's Block 0 re-measurement:
"Chat first-token latency: p50 ~7.8s (two sequential LLM calls at provider
inference-start floor). Original <3s exit bar UNMET and not waived —
converted to a Phase 5 exit item. Shipped because time-to-first-stage p50
~220ms gives immediate visible progress. Optimization levers to evaluate
(Phase 5 exit or Phase 6 sidecar): faster model tier for query-gen
specifically; streaming/early-start of answer generation; schema-context
caching in prompts; skip-rewrite fast path for simple single-source
queries. Re-measure after any lever; target ≤5s p50, aspiration ≤3s."

Session 4 numbers this ruling responds to: p50 7846ms / p95 8089ms
(`apps/web/latency_hops.mjs`, 10 runs), vs. Phase 4's p50 8431-8603ms /
p95 12276-12642ms (`PHASE4_EXIT.md`). Time-to-first-stage-event (not
first-token) is separately p50 ~219-220ms, which is what "immediate
visible progress" refers to above — the UI shows activity within ~220ms
even though the full answer's first token doesn't land until ~7.8s later.

## Phase 5 Session 5, Block 3: latency-lever re-verification, live evidence

Re-checked the four levers this ruling lists, against the plan's specific
requirement to re-verify with live evidence rather than re-reading old
docs. Nothing implemented — all four close out as investigation-only,
consistent with "implement only if cheap and golden-gated," since none
clears that bar. Cross-references `PHASE4_EXIT.md` §4.4 Fix 1-3, which
originally diagnosed these; this entry reconfirms live, today, that
nothing has changed.

**Lever 1 (faster query-gen model tier) — still blocked, reconfirmed live.**
Direct probe against the gateway (`google/gemini-3.5-flash`, bypassing
the worker) reproduces Phase 4's exact finding: `provider_metadata.gateway
.routing` shows the Google BYOK credential failing
(`"API key not valid. Please pass a valid API key.", statusCode: 400`),
falling back to a `vertex` system credential
(`resolvedProvider`/`finalProvider: "vertex"`), which carries a mandatory
~100-150 reasoning-token overhead (`usage.completion_tokens_details
.reasoning_tokens: 149` this run) baked into every Gemini call regardless
of prompt. `usage.is_byok: false` confirms the fallback. Unchanged from
Phase 4; still blocked on the platform-level BYOK credential, not
anything in this codebase.

**Lever 2 (skip-rewrite fast path) — N/A, no-op confirmed.**
`apps/worker/src/lib/chat/nodes/rewrite.ts` is a pure pass-through (emits
its `rewriting` status event and forwards `state` unchanged) — there is
no rewrite work being done for any query shape, simple or complex, so
there is nothing to skip. No code change.

**Lever 3 (schema-context caching) — technically available (undocumented),
zero latency benefit, not implemented.** `.nia/assets/API_REFERENCE.md`'s
documented `/v1/chat/completions` schema lists only `model`/`messages`/
`stream`/`stream_options` — no `cache_control` field. Empirically tested
anyway (per the plan's instruction to check the gateway directly, not
just its docs): an Anthropic-style content-block system message with
`cache_control: {type: "ephemeral"}` against `anthropic/claude-sonnet-4-6`
IS accepted and functional despite being undocumented — first call
produced `cache_creation_input_tokens: 1808`; a repeat call against the
same block produced `cached_tokens: 1808` with a ~89% cost drop
(`0.006873` → `0.0006354`). This is a real, previously-unknown capability
worth a future cost-optimization ledger entry (out of scope here). But a
clean miss-vs-hit latency comparison (fresh salted block to force a real
miss vs. a repeated block to force a hit) showed no measurable latency
difference: miss 4074ms, hits 4360ms / 4005ms — within noise of each
other. This confirms Phase 4's root-cause finding (provider
inference-start floor dominates, not prefill compute) holds for cached
prompts too. Not implemented: it would add real complexity (content-block
message shape, `gatewayClient.ts`'s `ChatMessage.content: string` would
need widening) for a cost win with zero effect on the latency bar this
block exists to move.

**Lever 4 (answer-gen early-start / connection warmup) — already moot,
confirmed live.** The plan's cheap candidate variant is a no-op warmup
fetch fired concurrently with `dispatch()`, on the premise that it primes
the connection for the following answer-gen LLM call. Measured the actual
gap this would need to bridge — `executing` (dispatch) stage-start to
`generating_answer` stage-start, from a separate 10-run `latency_hops.mjs`
probe capturing full per-stage timestamps (relative stage gap, not
compared to the headline totals below, which came from a different run
on a noisier machine state) — and it is 54-113ms across all 10 runs
(min 54, median 89, max 113). Node's built-in fetch (undici) keeps
connections alive by default with a documented `keepAliveTimeout` of
4000ms; the measured gap is 35-70x smaller than that window. The
connection used for the immediately-preceding `generateQuery` LLM call on
the same process/singleton `OpenAI` client (`gatewayClient.ts`) is
trivially still warm by the time `buildAnswer` fires — there is no cold
connection for a warmup to prevent. No code change.

Re-measured with `node latency_hops.mjs` (10 runs, real
`@mysql-dev` connection, chromium via Playwright) after concluding no
lever should be implemented: p50 8517ms / p95 11275ms — within noise of
Session 4's p50 7846ms / p95 8089ms, no regression. Still fails the
original <3s bar; ≤5s p50 target also unmet. Golden set re-run is not
required by the plan's own conditional wording ("full golden set must
hold after any implemented lever") since no lever was implemented.
Latency remains an open Phase 5 exit item, carried forward with this
session's live re-verification as the current evidence.

## Phase 5 Session 5, Block 4: semantic-conflict golden case — organic trigger unreachable, live-evidenced

Goal per plan: a golden fixture where two sources share the same numeric
value with contradictory semantics, engineered so `reduce.ts`'s
deterministic tie-check does NOT catch it, forcing only the LLM
faithfulness grader to catch the mismatch — proving the shared
`conflict-retry` → `conflict-final` retry policy (`applyFaithfulnessVerdict`,
`faithfulness.ts`) actually fires end-to-end, not just in isolation.

**Infrastructure landed (kept, harmless regardless of the finding below):**
`runChatQuery.ts`'s `ChatQueryResult` "ok" variant now surfaces
`faithfulnessOutcome`/`answerGenAttempts` (previously only `faithful:
boolean`); `goldenCase.ts`'s `expect` schema gained an optional
`expectFaithfulnessOutcome: "ok" | "conflict-final"`; `runGoldenSuite.ts`'s
`"answer"` case branches on it — when set to `"conflict-final"` it does
NOT auto-fail on `faithful:false`, instead asserting
`faithfulnessOutcome === "conflict-final"` and `answerGenAttempts === 1`.
No fixture case sets this field today (see below).

**The originally-designed mechanism does not work, confirmed by reading
the actual prompts, not just inspection.** The plan's illustrative
"different field name per source" example is inexpressible at all:
`reductionPlan.ts` classifies `targetField` from question text alone,
with no schema access, and assumes one field name means the same thing
across every source (no field-mapping). Its actual replacement —
"single true winner on a target field, whose winning row ALSO has a
second, coincidentally-equal-valued column with different real-world
meaning" — was live-tested (multi-source, mysql `tenure`=15/`incidents`=15
on the same Grace Hopper row, mongo capped below the mysql max so no
cross-source tie ever forms) and does NOT trigger a conflict, because
`formatOutcome()` (`answerGenMulti.ts`) hands the ENTIRE winning row to
BOTH `buildAnswerMulti` and `faithfulnessMulti` — the grader has the same
context the answer came from, so restating any of that row's real,
given values is correctly graded `OK`, not `CONFLICT`. The faithfulness
prompt's "without fabricating any other numeric claim" wording reads, in
practice, as "beyond what you were given" — not "beyond the bare target
field" as originally assumed.

**Live evidence, multi-source (mysql `tenure`/`incidents` seed, temporary
— since reverted, see below):**
- Bare question ("Who has the highest tenure, across these sources?"),
  8 consecutive real runs: 8/8 `faithfulnessOutcome: "ok"`,
  `answerGenAttempts: 0`, byte-identical structure each time. Zero
  organic variance.
- Two-part elaboration ("...and what does their record show?"): still
  `ok` — model volunteers salary/incidents unprompted but all
  grounded in the given row, so still graded faithful.
- Fabrication-bait questions requiring a second computed fact not in the
  given result (second-highest delta, percentage-of-total, decade/month
  unit conversion, within-row field comparison, "flag anything
  concerning"): every one of these was refused upstream by
  `reductionPlan.ts`'s classifier as `unsupported-operation` before ever
  reaching `buildAnswerMulti`/faithfulness — the classifier's "requires
  more than one number combined" rule is a second, independent backstop
  the plan's example didn't account for.
- Unit-mismatch bait ("...in months?"): model restated the same number
  15 relabeled "15 months" — faithfulness only tracks number identity,
  not unit/label consistency, so this also passed `ok`.

**Live evidence, single-source (the one surface with no deterministic
reduce.ts backstop — `buildAnswerNode` has the LLM compute the answer
directly from raw rows, per `buildAnswer.ts`/`answerGen.ts`):** seeded 10
extra mysql rows (temporary) with awkward two-digit tenure values (13
rows total, true sum 239) and asked the model to hand-compute a running
total from the raw row dump rather than use SQL `SUM`. It produced a
byte-perfect running-total table (239, matching exactly) and added
correctly-derived extra facts (correct min/max by name) — still `ok`.

**Sidecar ledger entry (Phase 6 Block 1, not this block's work):** BYOK
credential rejected (`"API key not valid"`) forces the Vertex fallback +
its ~100-150 reasoning-token tax described above under "Lever 1" — this is
carried forward as a to-do, not re-investigated here: fix the underlying
BYOK credential, then re-run latency lever 1's direct-gateway probe to see
if a real (non-Vertex-fallback) `google/gemini-3.5-flash` measurement
changes the query-gen latency picture. Out of scope for Block 1 itself.

**Conclusion:** with the current gateway model, this pipeline's
defense-in-depth (deterministic `reduce.ts` for multi-source removing
LLM arithmetic entirely; a classifier that refuses any question needing
more than one computed fact; an answer-gen prompt that's followed
reliably even under adversarial single-source hand-computation load)
makes an organically-triggered faithfulness conflict empirically
unreachable via honest data/question engineering within the effort spent
here (7 distinct provocation strategies across 15 real pipeline
invocations, multi- and single-source). This is a legitimate system
finding, not a gap in effort — recorded here rather than shipping a
fixture that pretends to exercise a path it doesn't. All temporary seed
changes (mysql/mongo `tenure`/`incidents` columns, the 10 extra
single-source rows) were reverted live and never landed in
`docker/dev-*-init.sql`/`.js`; no fixture case was added to
`chat-v1.jsonl`. The `expectFaithfulnessOutcome` plumbing above is left
in place for if/when a real trigger (e.g. a future weaker/cheaper model
tier, or a genuine product bug) is found — at that point a case can be
added directly, no further infra work needed.

## Phase 6 Block 1: aggregate-transform vocabulary — mandatory reference digest, standing directive

Recorded verbatim per the Phase 6 kickoff: "Standing directive: before
designing the aggregate-transform vocabulary or any DAX/PowerBI semantics,
read every row of every sheet under Reference/, then produce a digest
proving comprehension — (a) the reference's category taxonomy, (b) which
patterns map cleanly to SQL/Mongo pushdown, (c) which are
filter-context-specific (CALCULATE/ALL/ALLEXCEPT family) and their
semantic equivalent in our transform model, (d) which apply only to a
future DAX-emitting PowerBI path. The digest is reviewed before
implementation. The reference is a coverage checklist and semantic guide,
not literal DAX transplantation."

(Repo path is `reference/`, lowercase, not `Reference/` — same directory
the directive refers to; `reference/DAX_Reference_Guide.xlsx` +
`reference/README.md` are committed as of Phase 6 Block 1. Per the
kickoff's item 1c: CSV exports of both sheets — `dax-reference.csv`,
`combined-formula-patterns.csv` — are NOT present on disk yet; per the
kickoff's own instruction ("if the files aren't present on disk at all,
STOP and tell the user to add them before continuing") this is flagged
back to the user rather than silently skipped or fabricated. This does not
block Block 1's other items — the digest/vocabulary work itself is
explicitly a later Phase 6 session, not this block's work.)

## Phase 6 Block 1: write-grant RBAC — kept all-role, matching DECISION-C

The Phase 6 kickoff's original migration spec (item 1e) called for
`create_write_grant`/`confirm_write_grant`/`revoke_write_grant` to require
org admin/owner (or the personal-workspace owner), on the reasoning that
minting a write grant is materially higher-stakes than the other
"work" actions `can.ts`'s DECISION-C already made all-role (individual/
member/admin/owner). Raised back to the user as a real conflict before
drafting the migration (write_grants already shipped in
`0007_connectors.sql`, client-writable by any member via RLS — this isn't
a fresh design choice, it's an existing precedent). Ruling: **keep
`grants.create`/`grants.revoke` all-role**, consistent with the already-
shipped `write_grants` RLS and `can.ts`'s existing DECISION-C — no change
to `can.ts`'s matrix. The RPC-only lockdown (no direct client
INSERT/UPDATE on `write_grants`, all mutation through the three
`SECURITY DEFINER` RPCs) still applies regardless of role, and the RPCs
still re-derive workspace access the same way the table's own RLS did
(`private.is_member`/`owner_id = auth.uid()`) — only the "does this
specific action additionally require admin/owner" question was decided
against. Role restriction on write-grant minting was considered and
deliberately deferred, not rejected outright — revisit before an
enterprise/org GA if a real incident or compliance requirement surfaces
that DECISION-C's blanket work/governance split doesn't cover for this one
credential-minting action specifically.

## Phase 6 Block 2 follow-up: route-skew guard is advisory-only; full version handshake deferred to Phase 9 hardening

`HealthResponse` (`packages/schemas/src/contract.ts`) gained a `routes:
string[]` field, populated literally by each connector service's `/health`
handler (`services/connector-{mysql,mongodb,supabase}/src/index.ts`) with
its actually-registered route names. `apps/worker/src/lib/routeAwareness.ts`
probes this once per connector per worker process (cached for the process
lifetime) and `console.warn`s if a connector is about to be dispatched to on
a route it doesn't advertise (e.g. an older connector-mysql image predating
a new route) — wired as a non-awaited, fire-and-forget call at the top of
`connectorClient.ts`'s four `send*` functions. This is deliberately a cheap
stopgap for one specific failure mode (stale service image), not real
version negotiation: no semver compatibility check, no capability
negotiation, no blocking/refusing dispatch when a route is missing (a raw
404 still surfaces from the real call — the warning just makes the cause
obvious in logs instead of leaving it a mystery). Full version handshake
deferred to Phase 9 hardening.

## Phase 6 Block 3: ETL runner — scope cuts and the run-stream auth fix

Landed the actual workflow-execution path against the pre-existing
`workflow_runs` table (`0002_projects_workflows.sql`, org/personal-scoped
since `0005_individual_workspace.sql` — no new migration needed this
block), `apps/worker/src/lib/etl/runEtl.ts`'s
chunked/checkpointed/resumable job chain (self-requeuing BullMQ jobs,
`MAX_CHUNK_ROWS = 1000` per the guardrails clamp), `packages/schemas/src/
runEvents.ts`'s `RunStreamEvent`/`RunStreamEnvelope` types, and
`POST /workflows/:id/run` + `GET /workflows/:id/run/stream` on the API
side, mirroring chat's enqueue-then-SSE-replay shape
(`apps/api/src/lib/runChannel.ts`, `apps/api/src/lib/runQueue.ts`,
`apps/api/src/services/runs.ts`).

**Scope cuts, all deliberate:**
- **Single destination node per run.** A run targets exactly one
  destination (`destNodeId`); a graph with zero or multiple destination
  nodes can't be run at all yet (`FlowCanvas.tsx`'s `runNodeId` is `null`
  in both cases, surfaced via the Run button's tooltip, not a silent
  no-op). Multi-destination fan-out is future work.
- **Org-only execution.** `services/runs.ts`'s `startWorkflowRun` rejects
  a personal-workspace actor with a clean 400 — `EtlRunJob` has no
  personal-workspace scope yet.
- **No mapping/entity/upsert-key re-validation in the UI.** `runEtl.ts`
  itself validates all of that (approved field mapping, resolved entity,
  non-empty `upsertKeys`, source path) and publishes a clean `error`
  stream event on failure rather than throwing an HTTP error — the Run
  button only gates on the structural single-destination constraint above
  and lets the stream surface anything deeper, rather than duplicating
  that validation client-side as a second place to keep in sync.
- **Best-effort pagination ordering, raw-fetch-then-in-process-transform.**
  Consistent with the connector dispatch path's existing constraints
  (Phase 1/Block 2) — not re-litigated here.

**Auth bug caught and fixed before shipping to the UI:** the two run
routes were initially placed on `workflowsRouter`, which applies
Bearer-only `requireAuth`. Since `GET /:id/run/stream` is consumed by a
browser `EventSource` — which cannot attach a custom `Authorization`
header, only same-origin cookies — that would have made the stream route
always 401 in real use. Fixed by extracting both routes into a new
`apps/api/src/routes/runs.ts`, using `requireCookieAuth` +
`attachActor` exactly like `routes/chat.ts` (see this file's "API auth:
Bearer is the default" entry above), mounted at `/` in `index.ts`
alongside `chatRouter`. `apps/web/src/lib/api/runsClient.ts` mirrors
`chatClient.ts`'s plain-`fetch`/`EventSource`-with-no-custom-headers
pattern accordingly (not `previewClient.ts`/`checksClient.ts`'s explicit
Bearer-header pattern, which targets the Bearer-only routers).

**UI:** `MappingEditor.tsx` gained an "Upsert keys" checkbox section
(scoped to only the destination fields present in the current field
mapping); `FlowCanvas.tsx`'s Run button now calls `startWorkflowRun` +
`streamRun` for real (replacing the earlier Phase 6 stub modal) and
renders a live bottom-right status panel (`starting` /
`running` with running row count / `done` with row count + duration /
`error` with message), dismissible independently of stream lifecycle.

## Phase 6 Block 3.5 ledger hygiene: naming Block 3's two scope cuts' destinations

Block 3's "Scope cuts" list above left both cuts open-ended ("future work" /
"`EtlRunJob` has no personal-workspace scope yet"). Per the Block 3.5
kickoff's ledger-hygiene item, both now name where the cut work actually
lands:

- **Multi-destination fan-out** (a run targeting more than one destination
  node in the same graph) — **DONE, Block 5 (Part 3c):** answered "independent
  per-destination cursors, no shared gating" — each destination gets its own
  runId/checkpoint/SSE stream, minted in an ordinary loop over `destNodeIds`
  (`services/runs.ts`'s `startWorkflowRun`); `runEtl.ts`/`workflowRuns.ts`/
  `publish.ts` needed no change since they were already keyed per-runId, not
  per-workflow. `FlowCanvas.tsx` tracks `runNodeIds`/a status-panel list
  instead of a single run. Live-verified: two independent runIds minted for
  the same destination, both completed, rows landed idempotently (no dupes).
- **Personal-workspace execution** (`EtlRunJob.orgId: string` — plain,
  non-`WorkspaceScope`-union, per `jobs.ts`'s own header comment on that
  field) — **DONE, Block 5 (Part 3d):** `EtlRunJob.orgId` → `EtlRunJob.scope:
  WorkspaceScope`, same union `ChatQueryJob`/`CheckRunJob` already use.
  `workflowRuns.ts`'s `startRun` now writes `org_id` or `owner_id` depending
  on which half of the union the job carries (`workflow_runs` already had a
  nullable `owner_id` + `org_xor_owner` check constraint + owner-aware select
  policy since `0005_individual_workspace.sql` — no migration needed, only
  the job payload and its two consumers, api's `services/runs.ts` and
  worker's `workflowRuns.ts`/`runEtl.ts`, were still hardcoded to orgId).
  `services/runs.ts`'s `startWorkflowRun` no longer rejects a
  personal-workspace actor — `routes/runs.ts`'s `scopeFromActor` already
  branched org-vs-personal the same way chat/checks do, it just wasn't
  reaching a scope-generic job payload before. Runner test suite
  (`runEtl.test.ts`) updated to the new `scope` field, all 11 cases still
  pass; `@nia/worker`/`@nia/api`/`@nia/web` typecheck clean.

## Phase 6 Block 4 correction: the grant-creation UI never shipped in Block 2

Block 2's kickoff spec included a UI requirement — the grant flow should
display copy-ready `CREATE ROLE` / `GRANT` statements per dialect,
accept a write credential, and drive the two-step create/confirm — and
Block 2's closing report (`ecbc225`) listed "NodeDrawer.tsx /
connectionsClient.ts: UI unlock for confirming/revoking write grants"
as delivered. That line is accurate only for the **read side**: the
verb-lock/unlock display in `NodeDrawer.tsx`'s `SourceDestForm`, driven
by `getWriteGrants()`. It was never accurate for a **creation** UI —
no component anywhere in `apps/web` calls `create_write_grant` or
`confirm_write_grant`, generates any `CREATE ROLE`/`GRANT` SQL text, or
accepts a write credential. `ConnectionsClient.tsx`'s own comment
concedes this directly ("Write-grants (mint/revoke) are deliberately
not surfaced here yet, per the fixed Step 5 scope") and its "Manage"
button is a disabled `title="Coming soon"` placeholder. This was
discovered during Block 4's E2E test build, not fixed in place (Block 4
is a proof block, not new product surface) — the E2E instead drives
grant creation/confirmation via the same RPC calls `write-smoke.ts`
already uses, and only exercises real UI for the read side (verb
lock/unlock, `checkGrants` pass/fail) and everything downstream (run,
status panel, Logs). The grant-creation UI itself (statement display +
credential entry + two-step confirm) now explicitly lands in **Block 5
(write-path generalization)**, where mysql/mongo destination dialects
make the per-dialect statement text a real requirement anyway rather
than a supabase-only stub.

## User-authorized fast mode (2026-09-18): full proof battery deferred

User explicitly directed a speed-priority pass on Phase 6 Block 4/5
rather than the full proof battery: "skip unnecessary tests... we can
come back and fix small bugs later." Recorded here so this isn't
mistaken for silently-dropped rigor later. **Deferred to a named
verification session before PHASE6_EXIT:**

- The full 1,000,000-row × 2-runs kill -9 resilience test
  (`apps/worker/scripts/kill-test.ts` — script exists, written Block 4,
  still unrun at full scale). A smaller mechanism-only version (single
  kill point, reduced row count) was run in its place this session — see
  this session's kill-test artifact log for the row count/kill point
  actually used, and the result.
- The grant/run/status-panel Playwright E2E test (Block 4's other
  planned proof artifact).
- A live probe battery / isolation measurement pass across the new
  mysql/mongodb write paths (Block 5) beyond the single 3-row live smoke
  test each got this session.

**Two standing pointers, answered plainly so a future session doesn't
have to re-derive them:**
- Checkpoint/cursor truth lives in Postgres (`workflow_runs.cursor_json`,
  migration `0017_run_checkpoints.sql`), not the Redis job payload — see
  `runEtl.ts`'s resume logic and Block 3.5 item 1 above. The job payload
  cursor is a transport hint only; the persisted cursor always wins on
  redelivery/resume.
- The entity run-gate is a hard runtime precondition: `runEtl.ts`/
  `startWorkflowRun` reject an unset source entity at run start (not a
  soft warn) — `checks.ts`'s pre-flight check stays `warn`-level by
  design (existing graphs keep checking green), but the Run button's own
  tooltip and the runner itself both enforce hard-fail. See Block 3.5
  item 2 above.

## Phase 6 Block 6: aggregate transform — v1 vocabulary, shipped and proven

Implemented the Stage 1-approved v1 aggregate vocabulary end to end:
schema (`nodeConfig.ts`'s `AggregateStep`/`AggregationSpec`, fns `count,
count_field, count_distinct, sum, avg, min, max`, `groupBy: string[]`
with `[]` meaning whole-table aggregate, `having` reusing
`FilterCondition`), pushdown compilation to real SQL `GROUP BY`/`HAVING`
(mysql/postgres) and Mongo `$group` (`pushdown.ts`), the ETL runner's
non-paginated aggregate execution path (`runEtl.ts`), residual (in-
process) execution for non-pushable cases (`residualTransform.ts`),
`checkConfig` validation (`checks.ts`), and the `AggregateStepEditor` UI
in the transform drawer (`TransformEditor.tsx`).

**Ruling 1 (%-of-total) — the finding held, nothing was quietly made
first-class.** The task's explicit instruction was to stop and report if
the composition proof broke rather than silently promoting `%_of_total`
to a first-class fn. It did not break, but it also does not prove what a
first read of "%-of-total via composition" might suggest: a literal
broadcast %-of-total (each row divided by one whole-table total, same
grain in/out) is **not expressible** through this transform chain — no
window/join primitive exists, and chaining can only change or collapse
grain, never broadcast a coarser aggregate back onto finer rows. What
`pushdown.test.ts`'s ruling-1 test actually proves is narrower but real:
(a) dividing two sibling aggregation aliases from the *same* Aggregate
step via a residual `computed_field` (sum ÷ count → avg-shaped ratio),
and (b) a second, coarser-grain Aggregate step validly chaining after a
pushed one as a residual multi-level rollup. Both are genuine, tested
compositions; neither is a full %-of-total. `nodeConfig.ts`'s
`AggregateStep` doc comment and `TODO.md`'s Block 6 ledger both state
this precisely so it isn't misread as "solved" later. No window/join
primitive was built to close the gap — out of scope for v1, parked per
the original Stage 1 framing (revisit only on real user friction).

**Ruling 2 (having validation) — enforced at check-time, not schema-time.**
`FilterCondition.field` is just a string; the schema can't tell a raw
upstream field from an aggregation alias. `checks.ts`'s new aggregate
branch restricts `having` field references to `[...groupBy,
...aggregation aliases]` and fails with a clear message naming the
offending field otherwise. `AggregateStepEditor`'s having-condition
builder mirrors this at the UI level (its field dropdown is populated
from `havingFieldOptions = [...groupBy, ...non-empty aliases]` only, so
a raw field can't even be selected from the UI in the first place —
belt-and-suspenders with the check-time enforcement, not a replacement
for it).

**Ruling 3 (residual memory constraint) — documented once, at the
implementation site.** `residualTransform.ts`'s aggregate case carries
the required comment: residual aggregation buffers per-group state (a
`Map` of group-key → accumulators, plus a `Set` per `count_distinct`
aggregation) entirely in memory for the chunk being processed.
Pushdown-eligible aggregates are strongly preferred for that reason.
Streaming/spillable aggregation is ledgered in `TODO.md` as a future
item, not built this block.

**Ruling 4 (alias collisions include groupBy names) — enforced in both
layers.** `checks.ts`'s aggregate branch seeds its collision-detection
`Set` with `step.groupBy` before checking aggregation aliases against
it, so an alias that collides with a groupBy field name fails exactly
like a sibling-alias collision would. `AggregateStepEditor`'s
`outputNames` map does the same union at the UI level, driving the
live red-border/warning-banner feedback.

**Architectural finding not in the original four rulings: keyset
pagination is fundamentally incompatible with GROUP BY.** The ETL
runner's chunking model pages by the source table's primary key: GROUP
BY collapses row cardinality, so there is no meaningful post-aggregation
cursor to page over. Resolution (disclosed in `TODO.md`, not hidden):
a pushed-down aggregate query executes as a single non-paginated read,
capped at `MAX_CHUNK_ROWS` (1000 output rows), with `isLastChunk` forced
`true` unconditionally. A workflow whose grouped output would exceed
1000 rows truncates silently today — no warning surfaces yet. This is a
real v1 limitation, not an edge case glossed over; a correct fix would
need an aggregate-aware cursor (e.g. keyset over the groupBy columns) or
a pre-flight row-count check, neither of which was in scope for this
block.

**Two more structural pushdown limits, both by design
(`pushdown.ts`'s `splitPushable`):** a pushed Aggregate step can only be
preceded by `filter` steps — a preceding `computed_field` or
`drop_fields` forces the whole aggregate to residual, since pushdown
doesn't attempt to translate arbitrary computed-field expressions into
the dialect's SELECT list ahead of a GROUP BY. And at most one Aggregate
step is ever pushed per node; a second Aggregate step always falls to
residual (this is exactly the proven multi-level-rollup composition case
under ruling 1, not an oversight).

**Proof artifact — live smoke test, "highest salary per cohort"
(`apps/worker/scripts/aggregate-smoke.ts`):** a real mysql sandbox
source table (6 rows, 3 cohorts: eng/sales/ops), a real Aggregate
transform node (`MAX(salary) GROUP BY cohort`), and a real Postgres
destination table, driven through the actual `runEtl()` runner (not a
hand-rolled query) against live docker-compose sandbox infra + the
local Supabase stack. The script independently compiles and asserts the
pushdown plan (`residualCount === 0`, `pushedDownCount === 1`,
`dialectQuery.isAggregate === true`) as proof the aggregation is a real
`GROUP BY`, not client-side aggregation, then asserts `runEtl()` returns
`status: "done"` on its first call with zero next-chunk jobs enqueued
(proving the no-pagination-for-aggregates behavior above), then verifies
the 3 destination rows by direct query against the exact expected
per-cohort maxima, and finally verifies `workflow_runs.rows_processed
=== 3` (the aggregated output row count, not the 6 source rows). Ran
clean on first execution, all 8 assertions passed. Full output
captured verbatim in the Block 6 closing report.

**Addendum — Postgres/Supabase as aggregate SOURCE, not just
destination.** Closed a coverage gap raised after Block 6 shipped: the
above smoke test only ever executed Postgres SQL as a *destination*
verification read, never as a compiled aggregate SOURCE read. Findings:

- The compiler's dialect axis is, and always was, ONE generic emitter —
  `compileSql(steps, dialect: SqlDialect)` (`pushdown.ts`), with exactly
  two dialect-conditional primitives: `quoteIdent` (backtick vs
  double-quote) and `placeholder` (`?` vs `$n`) (`pushdown.ts:182-189`).
  It is not mysql-specific; postgres was already a first-class emit
  target for the aggregate pushdown before this addendum — no new
  compiler code was needed, only test-coverage systematization.
- `pushdown.test.ts`'s aggregate describe blocks were restructured into
  `describe.each(["mysql","postgres"])` (SQL side) plus a matching
  mongo block, giving full 3-column parity: 9 cases x 3 dialects = 27
  aggregate tests (GROUP BY+MAX, whole-table, count/count_field/
  count_distinct, filter-ahead, having-on-alias, having-on-groupBy-field,
  computed_field-blocks-into-residual, and both ruling-1 composition
  cases — sibling-alias division and multi-level rollup).
- Disclosed finding surfaced while extending the mongo cases:
  `splitPushable`'s "a non-filter step ahead of a pushed Aggregate blocks
  it into residual" rule is coded with no dialect check — it applies
  uniformly to mysql, postgres, AND mongo, even though mongo's
  aggregation pipeline could in principle express `$addFields` before
  `$group` as a real stage (unlike flat SQL, which cannot without a
  subquery/CTE). The v1 scope-cut is broader than strictly necessary for
  mongo, but intentional (one rule, one code path, easier to reason
  about) — not something this addendum changed.
- Confirmed `pushdown.ts`, `queryBuilder.ts`, and `runPreview.ts` all
  implement byte-identical local `quoteIdent` logic — the aggregate
  pushdown reuses the exact identifier/placeholder convention
  preview/chat query-gen already established, not a third one (a minor,
  disclosed 3-way duplication of a 4-line function, not a divergence).
- New proof artifact —
  `apps/worker/scripts/aggregate-smoke-postgres-source.ts`: flips the
  original smoke test's roles (Postgres sandbox table as SOURCE,
  `COUNT(*) GROUP BY cohort`, mysql sandbox table as DESTINATION), driven
  through the real `runEtl()` runner. Directly asserts the compiled
  plan's exact postgres SQL text (`selectSql: '"cohort", COUNT(*) AS
  "n"'`, `groupBySql: '"cohort"'`) before running it, then verifies the
  3 destination rows and `workflow_runs.rows_processed === 3`. Ran clean
  on first execution, all 8 assertions passed.

## Phase 7 Session 1: plan_propose's WorkspaceScope provenance is a known divergence, not a resolved question

`PlanProposeJob.scope: WorkspaceScope` follows the same substitute-for-RLS
pattern every other worker job already relies on (`resolveConnection.ts`'s
service_role client + mandatory scope filter — see that file's header
comment: "this scope filter is the ONLY thing standing between the worker
resolved someone else's connection and refused it"). This is not a fresh
design choice for Phase 7; it's the existing, established pattern, reused
rather than reinvented (see this plan's Context section, resolution 2).

**Traced live, end-to-end, for where `scope` will actually come from once a
route exists:** there is currently no `POST .../plan/propose`-shaped route
in `apps/api/src/routes` at all — the only caller of `PlanProposeJob` today
is the golden suite (`runPlanGoldenSuite.ts`), which constructs the payload
directly in-process and is not reachable from any HTTP surface. So there is
no active cross-tenant hole: nothing client-facing can supply `scope`
today. But the established, correct pattern for when that route IS built
(`scope = scopeFromActor(req.actor)`, `apps/api/src/lib/workspaceScope.ts:
10-13`, fully server-derived from the Supabase-JWT-verified actor —
`chat.ts`, the checks route, and the mappings route all already do exactly
this, never from the request body) has **not yet been implemented or
verified for `plan_propose`**, because the route doesn't exist yet. Record
this explicitly as a known divergence/gap to close in Session 3 (when
`CopilotSidebar.tsx`/`CommandBar.tsx` go live and the real enqueue route is
built), not a silently-assumed-safe resolved question: **the Session 3
route MUST derive `scope` via `scopeFromActor(req.actor)` (plus
`assertWorkflowInScope`, the same mandatory pre-enqueue check every
analogous route already performs), never from client-supplied body/query
fields.** If a future session builds that route without this, that
would be the actual cross-tenant hole the original review question was
probing for — this entry exists so that isn't rediscovered from scratch.

Also recorded per the same review: this whole scope-derivation chain is
itself the codebase's standing substitute for true row-level RLS
enforcement inside the worker (the worker's Supabase client is
service_role, which bypasses RLS entirely — see `resolveConnection.ts`'s
and `listVisibleConnections`'s header comments). A user-JWT-scoped worker
client (real RLS enforcement inside the worker, not a manually-reimplemented
filter) has no precedent anywhere in this codebase and was not built for
Phase 7 — deferred, not attempted, consistent with "don't invent a new
access-control pattern, reuse the one every other worker job already
trusts."
