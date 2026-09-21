# Phase 8 Exit Report — DRAFT

**Status: DRAFT, not final.** Phase 8b-3 (per-node `onFailure`/quarantine
behavior) is explicitly still open and out of scope for this report — this
covers 8a (op registry) and 8b-2 (DAX-derived function-vocabulary batches
0-6 plus their hardening follow-ups) only, i.e. everything through batch
6's regex-flavor follow-up closed out in this session.

**Commit status:** everything this report covers is committed — `89b299e`
("Phase 8a: op registry + dialect adapter seam") plus `677d692` ("Phase
8b-2: DAX-derived function vocabulary (batches 0-6) + op registry
hardening", 2026-09-21 11:31:35 +0530), which includes this file, the
+2786-line `docs/decisions.md` session log, `agreementCases.ts`, and every
core-implementation file listed in §7. The phase shipped ahead of this
exit-doc's own review/sign-off, which is still pending (8b-3 is also still
unaddressed).

---

## 1. What shipped, by sub-phase

| Sub-phase | What | decisions.md entry |
|---|---|---|
| 8a | Op registry + dialect adapter seam: collapsed ~8-10 inline per-op registration points and 3 duplicate `quoteIdent`/`placeholder` implementations into one op-registry pattern; behavior-preserving, no semantics change | "Phase 8a: op registry + dialect adapter seam" |
| 8b-1 | Expr grammar extended for the DAX-derived call-fn vocabulary (no standalone decisions.md section — see inline NULL-handling reference at the semantics-homogenization entry) | (undocumented as standalone section; referenced inline) |
| 8b-2a | `ops-db-conformance.ts` + `ops-agreement.ts` live harnesses built; found and fixed a Postgres CASE-branch literal-typing divergence, and a guardrails SQL-reconstruction bug that corrupted every dispatched mysql/postgres query using a multi-char operator (`<>`, `!=`, `<=`, `>=`) | "Postgres CASE-branch literal typing"; "guardrails SQL-reconstruction bug" |
| 8b-2b | Semantics homogenization: 8/8 live-found divergences across mysql/postgres/mongo/residual fixed via 5 targeted fixes, 0 declared-and-left | "Semantics homogenization" |
| batch 0 | mysql string-comparison collation pinned as a standing rule (`BINARY` forced when a literal string operand is involved); `isPushable` widening; `::` cast guard | "batch 0"; "batch 0 remainder" |
| batch 1 | Math core — 15 DAX-derived call-fns (`divide, round, round_up, round_down, abs, ceil, floor, round_to_multiple, mod, power, sqrt, sign, quotient, int, trunc`) | "batch 1: Math core" |
| batch 2 | Math remainder — `exp`, `ln`, `log` | "batch 2: Math remainder" |
| batch 3 | Text core — 11 call-fns (`upper, lower, trim, left, right, mid, len, substitute, find, rept, split`); largest batch, 3 prior live string bugs found here | "batch 3: Text core" |
| batch 3.5 | 3 standing follow-ups closed pre-batch-4 (guardrails keyword-collision scan, two others) | "batch 3.5" |
| batch 4 | Coercion — `to_number, to_integer, to_text, format_number, to_boolean, to_date`; `exact` proposed but dropped as redundant to batch 0's fix | "batch 4: Coercion" |
| pre-batch-5 hardening | 2 structural-enforcement items, then a postgres explicit-cast pass (Approach B, targeted, 4 conditions all satisfied), then a "stopped for a decision" checkpoint (2 real findings), then 3 approved fixes + 2 more bugs found/fixed along the way, then a date-column harness extension + numeric-precision probe | 5 entries under "pre-batch-5 hardening" |
| batch 5 | Date-part — 10 call-fns | "batch 5: Date-part" |
| batch 5 follow-up 1 | Cross-fragment `arg(n)`/params desync — **a live production bug**, fixed via `ParamSink` (`packages/schemas/src/ops/paramSink.ts`) | "batch 5 follow-up 1: ParamSink hardening" |
| batch 6 | Cleaning vocabulary — 7 functions (`regex_match, regex_extract, regex_replace, canonicalize, strip_accents, parse_date, parse_number`) | "batch 6: Cleaning vocabulary" |
| post-batch-6, this session | `bodyText` reconstruction verified as already rebuilt on source-span adjacency (not an operator allowlist) — structurally eliminates the whole "tokenizer splits an operator the source didn't" bug class; regex flavor-divergence risk formalized into a pinned, live-proven subset + a made-and-documented reject-vs-fallback decision (v1 scope, unvalidated passthrough) | "Post-batch-6: bodyText rebuilt on source spans"; "Batch 6 regex flavor divergence" + its "Follow-up: live edge-case probes run" subsection |

---

## 2. Bugs found and fixed this phase

Distinguishing **live production bugs** (silently wrong results a real
workflow could have hit, found via the live agreement/conformance
harnesses against real sandbox DBs) from **pre-ship catches** (found and
fixed before ever being exercised against real data, e.g. during
implementation or a pattern-audit pass):

**Live production bugs, silently-wrong-results class:**
1. **Guardrails SQL-reconstruction corruption — base operators** (8b-2a) —
   the token-rejoining `bodyText` reconstruction, driven by an operator
   allowlist (`MULTI_CHAR_OPERATORS`), didn't know about `<>`/`!=`/`<=`/
   `>=` and inserted stray whitespace inside them, corrupting every
   dispatched mysql/postgres query using one. Found via the
   `aggregate/mysql` and `aggregate/postgres` "having can also reference a
   groupBy field" fixtures failing at dispatch with real native syntax
   errors. **Classification: live-in-shipped-code, not a pre-ship catch.**
   `bodyText`'s naive token-join was in `validator.ts` unchanged since the
   initial commit (`c8bddb1`), and
   mysql/postgres comparison compiling (`neq`→`<>`, `gte`→`>=`,
   `lte`→`<=`) has existed since Phase 5's first pushdown-compiler commit
   (`8d7c20b`), unchanged through `89b299e` — verified by diffing both
   files at those revisions. Every `neq`/`gte`/`lte` filter or `having`
   clause dispatched against mysql/postgres in every shipped commit from
   `8d7c20b` through `89b299e` hit this. **Loud, not silent**: mysql/
   postgres both reject the mangled query with a real syntax error
   (fail-closed) — no wrong data was ever returned, the query errored.
2. **Postgres CASE-branch literal typing** (8b-2a) — a `computed_field`
   op with numeric-literal conditional branches came back as strings on
   Postgres but numbers elsewhere.
3. **Cross-fragment `arg(n)`/params desync** (batch 5 follow-up 1) — the
   6th live instance of an `arg(n)`-after-intermediate-SQL desync pattern
   and the first **cross-fragment** one (a helper computing one
   sub-fragment's params before a sibling fragment's own params were
   pushed, silently misaligning positional placeholders, concretely a
   mysql `filter` step before a `computed_field` step in the same node).
   Fixed via `ParamSink`, a centralizing param-push abstraction. **Fix
   status: shipped, commit `677d692`** (confirmed clean working tree, and
   confirmed pushed — `git status -sb` shows `main...origin/main` with no
   ahead/behind marker).
   **Exposure outcome** (full writeup: `docs/decisions.md`'s "Exposure
   assessment (requested follow-through, read-only)", under the batch 5
   follow-up 1 entry): window was 2026-09-18 09:02 IST (`28f9901`, ETL
   runner first combined the vulnerable fragments) through the fix's
   commit, `677d692` (2026-09-21 11:31:35 IST), now closed. A read-only
   `workflow_graphs` query for the bug's exact precondition (mysql source
   + a transform node with both a `filter` and a `computed_field` step)
   returned **0 rows at query time on both the linked/remote project (0
   `workflow_graphs` rows total at query time — no workflow existed there
   when the query ran) and the local dev DB** (4 mysql-source workflows
   exist locally, none use `computed_field`). **Conclusion: no real user
   was ever affected via a workflow.** This assumes the linked/remote
   `nia-core` project (per `supabase/config.toml`'s `project_id`) is the
   only production environment — a repo-wide search for other Supabase
   project refs, `.env*` files, and deploy configs (vercel.json/fly.toml/
   render.yaml/railway) found none; every `.env*` file in the tree is
   gitignored and untracked except the four `.env.example` templates.
   Caveat: this reflects *current* graph state at query time, not a
   historical audit trail, but is moot here given the remote project had
   zero `workflow_graphs` rows total. (Chat-SQL exposure is a separate
   question, not covered by this workflow-only check — see the exposure
   coverage note below.)
4. **8 semantics-homogenization divergences** (8b-2b) across mysql/
   postgres/mongo/residual on identical seed data — closed via 5 targeted
   fixes, 0 left as declared-and-accepted.
5. Additional divergences found and fixed during the "3 approved fixes"
   pre-batch-5 hardening pass, plus 2 more surfaced and fixed as a direct
   consequence of fixing those 3 (per the "every pattern-audit in this
   phase has turned up something" working assumption, which held again).
6. **`::` cast guard gap** at batch 0 remainder, and two further
   MULTI_CHAR_OPERATORS-adjacent gaps discovered later in the session
   (`::` itself, then `~*`/`||` in batch 6). **Classification, pushdown
   compiler: pre-ship catch, not live-in-shipped-code** — `is_number`/
   `is_text` (the `::` case) and `regex_extract`/`canonicalize` (the
   `~*`/`||` case) are the only call-fns that ever emit those operators
   via the pushdown compiler, and none of them existed in any previously-
   shipped, separately-committed state: `89b299e`'s `types.ts` has no
   `FN_PUSHABILITY` table and no `is_number`/`is_text`/`regex_extract`/
   `canonicalize` entries at all (verified by diff), and `89b299e`'s
   `sqlShared.ts` has none of `compileTrueTypeSql`/batch-6 emission code
   either — all introduced within this same session's single commit
   (`677d692`). Found and fixed by the live agreement harness before ever
   being committed via the pushdown path. **Loud** where it manifested
   (postgres `syntax error at or near ":"`/`"~"` — fail-closed), same
   mechanism as bug 1. The recurrence of this exact bug SHAPE across 3
   separate operators (`<>`/`!=`/`<=`/`>=` in bug 1, then `::`, then
   `~*`/`||` here) is what motivated this session's `bodyText` source-span
   rewrite, eliminating the allowlist-based approach structurally rather
   than patching a 4th instance.
   **Classification, chat SQL: live-in-shipped-code, independent of the
   pushdown compiler.** `::`, `~*`, and `||` are all ordinary, valid
   postgres syntax (`::` cast, `~*` case-insensitive regex match, `||`
   string concat; mysql's `||` is logical OR by default). Neither
   `apps/worker/src/lib/llm/prompts/queryGen.postgres.ts` nor
   `queryGen.mysql.ts` places any restriction on which operators the LLM
   may emit — there is no operator allowlist or few-shot example set in
   either prompt — and the generated SQL is dispatched through the exact
   same `validateReadOnlySql`/`bodyText` path as pushdown-compiled SQL
   (`packages/guardrails/src/sql/{postgres,mysql}.ts` both call
   `validateReadOnlySql` directly). The chat query-generation path
   (`apps/worker/src/lib/chat/nodes/generateQuery.ts`,
   `queryGen.{mysql,postgres}.ts`) has existed since commit `bcb7f53`
   ("Chat feature + worker dispatch/connector foundation"), long before
   `89b299e`/`677d692`. So although the pushdown compiler never emitted
   `::`/`~*`/`||` before this session, a user's free-form chat question
   could plausibly have caused the LLM to emit any of them in generated
   postgres/mysql SQL at any point since `bcb7f53`, which would have hit
   the same `bodyText` corruption as bug 1 — **loud/fail-closed** (native
   syntax error), not silent, same mechanism. This is a distinct, older
   exposure path from the pushdown-compiler one and is not covered by bug
   3's `workflow_graphs` exposure assessment (chat SQL never writes a
   `workflow_graphs` row) — see the exposure coverage note below for what
   the actual chat-usage data on the linked project shows.
7. **mysql string-comparison collation-insensitivity** (`=`/`<>`/`<`/
   `<=`/`>`/`>=`, batch 0) — mysql's default column collation is
   case-insensitive, so every equality/ordering filter compiled against a
   mysql source silently matched rows that a case-sensitive comparison
   (postgres/mongo/residual's shared, agreed-upon behavior) would have
   excluded. **Classification: live-in-shipped-code.**
   Unconditional `=`/`<>`/etc. compiling with no `BINARY` force existed
   from `8d7c20b` (Phase 5's first pushdown compiler) straight through
   `89b299e` (Phase 8a) unchanged — verified by diff — so every mysql-
   source filter/having clause dispatched in any of those shipped commits
   was exposed. **Silent**: the query executes successfully and returns
   wrong rows (case-insensitively over-matched), not an error — the
   opposite failure mode from bugs 1 and 6 above.
8. **node-postgres `NUMERIC`/`DECIMAL` returned as strings** (surfaced
   during pre-batch-5 hardening). `node-postgres` does not auto-parse OID
   1700 (`NUMERIC`/`DECIMAL`) into a JS `number` by default, but
   `services/connector-supabase/src/column-types.ts`'s
   `OID_TO_COLUMN_TYPE` has declared OID 1700 → `ColumnType: "number"`
   since the **initial commit** (`c8bddb1`) — verified via
   `git log --diff-filter=A`, no changes since. **Classification: live-
   in-shipped-code, silent, and the broadest-scope of the four bugs named
   above.** Unlike bugs 1/6/7 above (each gated behind a specific
   op/call-fn or filter operator introduced/changed this session), this
   one fires on ANY query through connector-supabase — ETL pushdown,
   preview, or chat SQL alike — that selects a real customer `NUMERIC`/
   `DECIMAL` postgres column, independent of anything Phase 8b-2 changed;
   this session's own CASE-branch cast (Fix 1, item 2 below) just newly
   *exercised* a gap that was already there. Fixed via a process-global
   `pg.types.setTypeParser(1700, parseFloat)` registered at
   `pool-manager.ts` module load — covers every pool and every query kind
   dispatched through connector-supabase, not just pushdown-compiled ones.

**Exposure coverage note, workflow vs. chat SQL:**
- **Workflow coverage: yes, for all four bugs (1, 6, 7, 8).** Bug 3's
  `workflow_graphs` query found **zero `workflow_graphs` rows total** on
  the linked/remote project — not just zero rows matching that one bug's
  specific precondition. Since no workflow of *any* shape ever existed
  there, no workflow could have triggered bugs 1, 6, 7, or 8 either,
  trivially.
- **Chat SQL coverage: assessed via a read-only user-level check on the
  linked project.** Chat SQL is generated ad hoc per question
  (`queryGen.{mysql,postgres,mongo}.ts`) and dispatched without ever
  writing a `workflow_graphs` row, so the workflow finding above says
  nothing about chat exposure on its own. Results:
  - `auth.users`: **1 row total**, email domain `gmail.com` — not an
    internal/company-controlled domain.
  - `public.conversations`: **0 rows**. `public.messages`: **0 rows**.
  - `public.audit_log`: 2 `organization.created` rows, 1
    `connection.execute` row.
  - **Because `public.conversations`/`public.messages` are both empty, no
    chat conversation has ever existed on the linked project, and
    therefore no chat-generated SQL has ever run** (postgres, mysql, or
    mongo) — this closes the chat-SQL angle for bugs 1, 6, and 8: zero
    chat activity means zero chat-SQL exposure via any of them, on this
    project, regardless of the account below.
  - The one `connection.execute` audit row is not chat SQL (no
    conversation exists to have produced it); it is most likely a
    workflow/preview dispatch or a manual connection test, both outside
    the scope of a read-only row-count check.
  - Bug 7 (mysql collation) has no separate chat-SQL angle: the collation
    behavior is inherent to the customer's own mysql database regardless
    of who wrote the SQL, and the zero-conversations finding already
    rules out any chat-issued query on this project.
  - **Flag, not resolved by this check: the single `auth.users` row is on
    an external (non-company) email domain, with real recorded account
    activity (`organization.created` x2, `connection.execute` x1).** Per
    the read-only, domain-only scope of this check, this is reported here
    rather than investigated further — whether this is a real external
    user or the maintainer's own test signup was not determined, and
    determining it would require inspecting the account beyond what this
    check was scoped to do.

**Pre-ship catches (found before hitting real data, still worth noting
given the volume):** the batch-0/1/3 string-collation and coercion bugs
noted inline in the batch 3 entry ("3 prior live string bugs" — these
were live-found but caught during that batch's own verification pass, not
by a downstream consumer), the guardrails keyword-collision scan (batch
3.5), and the numeric-precision probe's findings (pre-batch-5 hardening).

---

## 3. Standing rules established this phase

Not restated in full here — each is documented in its own decisions.md
entry, linked above in §1. In brief, for future sessions extending this
vocabulary:
- mysql string comparisons force `BINARY` when a literal string operand
  is involved (batch 0).
- Postgres explicit-cast pass uses Approach B (targeted, not blanket) —
  4 conditions, all satisfied (pre-batch-5 hardening item 3).
- `dist/` staleness for `@nia/schemas`/`@nia/guardrails` is now
  structurally impossible, not just a discipline note (pre-batch-5
  hardening items 1-2) — smoke scripts' `build:deps` prestep rebuilds
  both before every live run.
- `ParamSink` is the required pattern for any future op/fragment that
  needs to push SQL params across more than one compile sub-call (batch 5
  follow-up 1).
- `bodyText` in the guardrails validator is now derived from token source
  spans with adjacency-based joining, not an operator allowlist — any
  future multi-char operator added to the expr/SQL grammar needs **zero**
  guardrails-side bookkeeping (this session, Item 2).
- The regex vocabulary (batch 6) has a formally pinned, live-proven
  cross-evaluator supported subset (anchors, character classes incl.
  Perl shorthand, greedy/lazy quantifiers, backreferences, single
  lookahead) — out-of-subset patterns remain v1-scope unvalidated
  passthrough by deliberate decision, not an oversight (this session,
  Item 3).

---

## 4. Function vocabulary shipped, with pushability matrix

All functions below are pushable (`true`) on every dialect unless noted.
Source: `packages/schemas/src/ops/types.ts`'s `FN_PUSHABILITY`.

| Batch | Functions | Non-default pushability |
|---|---|---|
| pre-existing baseline (not batch-numbered) | `concat, coalesce, contains, is_null, is_not_null, is_number, is_text, looks_numeric` | all pushable, all dialects |
| 1/2 (Math) | `divide, round, round_up, round_down, abs, ceil, floor, round_to_multiple, mod, power, sqrt, sign, quotient, int, trunc, exp, ln, log` | all pushable, all dialects |
| 3 (Text) | `upper, lower, trim, left, right, mid, len, substitute, find, rept, split` | all pushable, all dialects, **except** `upper`/`lower`: `mongo: false` (residual-only there) |
| 4 (Coercion) | `to_number, to_integer, to_text, format_number, to_boolean, to_date` | all pushable, all dialects |
| 5 (Date-part) | `year, month, day, hour, minute, second, quarter, weekday, date_diff, date_add` | all pushable, all dialects |
| 6 (Cleaning) | `regex_match` | all pushable, all dialects |
| | `regex_extract` | `mysql: false` (mysql lacks a native group-index-capable regex-extract construct; residual there) |
| | `regex_replace` | `mongo: false` (residual there) |
| | `canonicalize` | `mongo: false` (residual there) |
| | `strip_accents` | **all dialects false** — residual-only, no pushdown anywhere |
| | `parse_date`, `parse_number` | all pushable, all dialects |

**Per-batch function counts**, verified against `FN_PUSHABILITY` in
`packages/schemas/src/ops/types.ts`: batch 1 (Math core) = 15, batch 2
(Math remainder) = 3, batch 3 (Text) = 11, batch 4 (Coercion) = 6, batch 5
(Date-part) = 10, batch 6 (Cleaning) = 7 — all match §1's per-batch
descriptions. The 8-function pre-existing-baseline group (`concat,
coalesce, contains, is_null, is_not_null, is_number, is_text,
looks_numeric`) is listed separately in the table above because none of
the 8 actually existed at `89b299e` either (confirmed via `git show
89b299e:packages/schemas/src/ops/types.ts`) — the whole group was
introduced fresh within `677d692`, not carried over from an earlier
shipped commit. It predates the DAX-derived batch numbering scheme
(batches 1-6), which is why it's unbatched rather than "batch 0".

**Citations for every non-default pushability above:** the rationale for
each is an inline doc comment directly above its `FN_PUSHABILITY` entry in
`packages/schemas/src/ops/types.ts` (`upper`/`lower`, `regex_extract`,
`regex_replace`, `canonicalize`, `strip_accents`), and each is backed by a
live cross-evaluator case in `apps/worker/scripts/lib/agreementCases.ts`
that exercises the skipped arm explicitly (e.g. `regex_extract`'s
mysql-skip cases at lines ~1304-1350, `canonicalize`'s mongo-skip cases at
~1373-1384, `strip_accents`'s all-arms-skip cases at ~1387-1401) — not
just a shape-only conformance fixture (no `regex_extract`/`regex_replace`/
`canonicalize`/`strip_accents` entries currently exist in
`packages/schemas/src/ops/__conformance__/fixtures.ts`, which is a
separate, real coverage gap worth noting: the live agreement suite proves
these via docker-sandbox execution, but the faster shape-only conformance
suite doesn't cover them at all).

---

## 5. Verification — this session's closeout (Items 1-3)

All of the below was re-run live this session, against real docker-
compose sandbox databases (mysql/postgres/mongo), not just typechecked:

- **Guardrails**: `pnpm --filter @nia/guardrails test -- --run` →
  4 test files, **72 passed | 1 expected fail** (73 total).
- **Schemas**: `pnpm --filter @nia/schemas test -- --run` →
  **422/422 passed**.
- **Worker**: `pnpm --filter @nia/worker test -- --run` →
  **135/135 passed**, 17 files.
- **Live cross-evaluator agreement suite**
  (`apps/worker/scripts/ops-agreement.ts`): **213/213 cases** (208
  pre-existing + 5 new Item-3 probe cases, 10 assertions counting the 3
  positive+negative pairs), **0 untriaged divergences**, 1 pre-existing
  declared-XFAIL (unrelated to this session). Docker Desktop crashed
  mid-run 3 times during this session's live-suite work (unrelated
  environmental flakiness on this dev machine, not a code issue) —
  discarded runs, clean reruns cited above.
- **Smoke scripts** (`apps/worker`, real dispatch against sandbox DBs via
  real connector services): `smoke` (dispatch-smoke.ts), `smoke:aggregate`,
  `smoke:write`, `smoke:write:mysql-mongo`, `smoke:chat` — **all
  "ALL PASSED"**.
- **Typecheck**: `@nia/schemas`, `@nia/guardrails`, `@nia/worker`,
  `@nia/web` — all clean, 0 errors.
- **Negative-rejection coverage** (guardrails validator's reject paths —
  forbidden keyword, multiple statements, non-SELECT, empty query,
  unparseable): spot-checked present and unchanged in
  `validator.test.ts` (9 rejection-reason-string references, 1
  `ok: false` structural assertion).

This closes out Item 2 (bodyText fix, fully verified, already
documented in decisions.md before this session even started) and Item 3
(regex flavor divergence, formalized from "untested" to a pinned,
live-proven subset with 32 total cross-evaluator assertions, plus a
made-and-documented reject-vs-fallback decision).

---

## 6. Pre-existing/unrelated issues discovered, not fixed

- **Docker Desktop instability on this dev machine**: crashed outright 3
  separate times this session during long-running live-suite runs
  (confirmed via `ps aux` showing only the `com.docker.vmnetd` helper
  surviving, main app gone). Root cause not identified (checked
  `vm_stat`/`top`/`df -h`, nothing conclusive). Mitigated each time by
  relaunching + a stabilization buffer before restarting the sandbox
  stack; not a code bug, but worth knowing about for future sessions
  running long live-suite work on this machine.
- **8b-1 (Expr grammar) has no standalone decisions.md section** — only
  an inline reference ("Phase 8b-1 disclosed several NULL-handling
  divergences under default") inside the semantics-homogenization entry.
  Not re-created retroactively this session; noted here so a future
  session doesn't assume it's missing by accident.

---

## 7. Files changed this phase (committed — `677d692`)

24 tracked files modified, 12 new files (scripts + `paramSink.ts`), all
part of commit `677d692` (`89b299e` for the 8a-only subset) — see `git
show --stat 677d692`:

**Core implementation:**
`packages/schemas/src/expression.ts` (+505/-…), `packages/schemas/src/ops/
types.ts`, `packages/schemas/src/ops/dialects/sqlShared.ts` (+1430),
`packages/schemas/src/ops/dialects/mongo.ts` (+1030),
`packages/schemas/src/ops/residualEval.ts` (+908),
`packages/schemas/src/ops/paramSink.ts` (new),
`packages/schemas/src/ops/{aggregate,computedField,dropFields,filter}.ts`,
`packages/schemas/src/{pushdown,nodeConfig,index}.ts`,
`packages/guardrails/src/sql/validator.ts` (+80/-…, the bodyText
source-span fix), `services/connector-supabase/src/pool-manager.ts`.

**Tests/fixtures:**
`packages/guardrails/src/sql/validator.test.ts` (+293, new),
`packages/schemas/src/expression.test.ts`,
`packages/schemas/src/pushdown.test.ts`,
`packages/schemas/src/ops/__conformance__/{fixtures,ops.conformance.test}.ts`.

**New live-harness scripts:**
`apps/worker/scripts/ops-agreement.ts`, `ops-db-conformance.ts`,
`lib/agreementCases.ts` + `lib/` support, plus a set of narrow one-off
probe scripts (`bigint-precision-probe.ts`, `collation-probe.ts`,
`date-literal-cast-probe.ts`, `date-part-fn-probe.ts`,
`mongo-date-fn-probe.ts`, `month-add-clamp-probe.ts`,
`numeric-precision-probe.ts`). A further one-off probe,
`tmp-mixed-branch-probe.mjs` (an ad hoc script for bug 2's CASE-branch
investigation), was deleted in the follow-up commit — not cited as
evidence anywhere in `docs/decisions.md`/`PHASE8_EXIT.md`/`TODO.md`
beyond a passing mention in this file list, and its finding is already
captured in bug 2 above.

**Docs:** `docs/decisions.md` (+2786 lines this phase — the full session
log this report summarizes), `TODO.md` (+61).

**Unrelated to this phase, resolved in the follow-up commit:**
`designs/background.mp4` — deleted as part of `677d692`; confirmed
unreferenced anywhere in `apps/web` (CSS/JSX/`public/`), so left deleted.
`apps/web/tsconfig.tsbuildinfo` — a generated build artifact that had
been tracked in git; untracked via `git rm --cached` with `*.tsbuildinfo`
added to `.gitignore` so it stops reappearing as a diff on every
typecheck. `apps/worker/package.json` script additions (the smoke-script
wiring referenced in §5) are unrelated to either fix and remain as-is.

---

## 8. Open risks / deferred, carried forward

- **Phase 9 keyset-collision prerequisite** (recorded in both TODO.md and
  decisions.md's batch-5-follow-up-1 entry): mysql's `?` placeholder
  binds by left-to-right text-scan position; appending a keyset
  pagination condition into `WHERE` after `ParamSink`'s resolve pass has
  already run would silently swap the keyset value into a `HAVING`
  placeholder's slot. Must route keyset conditions through `ParamSink`
  itself, or add a permanent regression case proving the keyset condition
  is always textually last, before Phase 9's keyset pagination work
  touches any query with both a `HAVING` clause and mysql's placeholder
  style.
- **Aggregate pushdown cap — false-positive fail, not silent truncation,
  pending Phase 9 aggregate pagination.** Effective cap: `requestedLimit =
  min(job.chunkSize, MAX_CHUNK_ROWS)`, `MAX_CHUNK_ROWS = 1000`
  (`apps/worker/src/lib/etl/queryBuilder.ts:36`). Applies identically to
  SQL and Mongo aggregate pushdown — both branches of
  `buildEtlReadQuery` pass the same `limit` value into a trailing
  `LIMIT ${limit}` (postgres/mysql, `queryBuilder.ts:73`) or `$limit:
  limit` stage (mongo, `queryBuilder.ts:55`), and `runEtl.ts` treats the
  result identically regardless of dialect. A guard already exists
  (`runEtl.ts:214-221`, shipped Phase 6 Block 6, commit `3872b5f` —
  predates Phase 8, not introduced this phase): if
  `sourceRowsFetched === requestedLimit`, the run hard-fails before
  `dispatchWrite` (zero destination rows written) with `Aggregate result
  may exceed ${requestedLimit} groups; refine group-by or raise the
  cap.` This is **not** the silent-truncation shape — it fails loud. Its
  known limitation (documented in both `runEtl.ts`'s own comment and
  `TODO.md:106-153`): fetching exactly `requestedLimit` rows can't be
  distinguished from a truncated result, so a workflow whose true
  GROUP BY output is legitimately exactly at the cap false-positive
  fails. **Proposed refinement (not implemented):** request
  `requestedLimit + 1` rows instead of `requestedLimit`; if more than
  `requestedLimit` come back, fail with the same clear cap-naming error
  (now a true positive, not a maybe); if `requestedLimit` or fewer come
  back, the true result set fit and can ship normally — eliminating the
  false-positive edge case without needing real aggregate-aware
  pagination. Still not a substitute for the real fix (a keyset cursor
  over the group-by columns, `TODO.md:120-123`); scoped as a stopgap
  until Phase 9's aggregate pagination work lands.
- **Regex out-of-subset patterns**: v1 scope is deliberately unvalidated
  passthrough (this session's Item 3 decision) — not reject-at-validation,
  not residual-fallback. Revisit if a real workflow hits a silent-
  wrong-result divergence (not just a native syntax error) from an
  out-of-subset pattern, or if future pattern-generating code needs to
  emit out-of-subset patterns as a matter of course.
- **8b-3** (per-node `onFailure`/quarantine behavior) — explicitly not
  started, out of scope for this report.
- **`strip_accents`** has zero pushdown anywhere (residual-only on all 3
  dialects) — accepted as-is, no native per-dialect equivalent
  investigated further this phase.

**Open flags carried forward from prior phases (not new to Phase 8):**
- **`canvas.spec.ts:274` skip** — `test.skip('source drawer: entity/table
  picker lists live tables... (Phase 6 Block 0)', ...)`, re-skipped per
  the inline comment ("RE-SKIPPED (Phase 7 verification gate,
  2026-09-18)"): passes in isolation (4/4 clean reruns cited in the
  comment) but fails when run inside the full ordered `.serial` suite —
  root-caused to a separate node-popover duplication bug in the
  screenshot test immediately above it, not fixed. Still skipped
  (confirmed by reading the file directly).
- **Phase 7 exit stamp**: `copilot.spec.ts` — **PASS**, cited artifact is
  `PHASE7_EXIT.md` §3: 6/6 passed, 2 runs, 2026-09-19, logs
  `/tmp/copilot_run1.log`/`/tmp/copilot_run2.log`. Carried forward as
  green, not re-run this phase.
- **Numeric precision needing product docs**: not yet written up in
  customer-facing docs. Live proof is
  `apps/worker/scripts/numeric-precision-probe.ts` +
  `docs/decisions.md`'s pre-batch-5-hardening Item 2 entry; tracked as an
  open TODO.md item (its "Surface the numeric-precision platform
  constraint..." bullet). Still open, not a Phase 8 deliverable.
- **Mongo raw `push(stage)` unvalidated escape hatch — investigated, not
  found.** Searched `services/connector-mongodb`,
  `packages/schemas/src/ops/dialects/mongo.ts`, `apps/worker`, and
  `apps/api` for any aggregation-stage construction that reaches a
  connector service without going through the op compiler or
  guardrails (`pipeline\.push|\.push\(stage|\$out|\$merge|\$function|
  \$where|\$accumulator`). All three real pipeline-construction paths
  were traced end-to-end:
  - ETL pushdown (`apps/worker/src/lib/etl/queryBuilder.ts`) — only
    app-constructed `pipeline.push({ $limit })`/`{ $match: { _id:
    { $gt: cursor } } }`/`{ $sort }` calls, no user input.
  - Preview (`apps/worker/src/lib/preview/runPreview.ts:139,164`) —
    `pipeline.push({ $project })` plus an `isReadShaped()` pre-check
    (only `$out`/`$merge`); this is defense-in-depth only, not the real
    enforcement — the pipeline still flows into `dispatch()` (line 281)
    same as every other path.
  - Chat (`apps/worker/src/lib/llm/prompts/queryGen.mongo.ts`) — LLM-
    generated pipeline; the prompt's own header comment states it
    "mirror[s] (but do not replace)" the real guardrails allowlist.

  All three converge on `apps/worker/src/lib/dispatch.ts:52`'s
  `validateBeforeDispatch(connection.connectorId, query,
  connectionScope)` — the single required chokepoint
  (`packages/guardrails/src/registry.ts`) and the only function able to
  mint a `ValidatedQuery`. For mongo this calls `validateMongoPipeline`
  (`packages/guardrails/src/mongodb.ts`), which enforces a 19-stage
  `ALLOWED_STAGES` allowlist, a `FORBIDDEN_OPERATORS` set (`$out`,
  `$merge`, `$function`, `$where`, `$accumulator`, `$expr_write`) caught
  by a **recursive** `scanForForbiddenOperators()` (any nesting depth,
  not just top-level stage keys), scope enforcement on `$lookup`/
  `$unionWith` targets, and a forced `$limit` cap
  (`DEFAULT_MAX_ROWS = 1000`). No call site bypasses this. **Conclusion:
  no open risk found.**
- **Mongo `$limit` cap on ETL extraction — confirmed per-page, not a
  total cap.** For non-aggregate sources,
  `apps/worker/src/lib/etl/queryBuilder.ts:58-60` builds each chunk as
  `$match: { _id: { $gt: cursor } }` + `$sort` + `$limit: requestedLimit`
  (`requestedLimit = min(job.chunkSize, MAX_CHUNK_ROWS=1000)`,
  `runEtl.ts:196`), and `runEtl.ts:255`'s `isLastChunk =
  isAggregatePushdown || sourceRowsFetched < requestedLimit` re-queues
  the next chunk with the advanced cursor whenever a page comes back
  full — proven by `apps/worker/src/lib/etl/runEtl.test.ts:174-199`
  ("writes the mapped rows, advances the cursor, and self-enqueues the
  next chunk when the source page is full"). `validateMongoPipeline`'s
  `DEFAULT_MAX_ROWS` (`packages/guardrails/src/mongodb.ts:29`) only
  enforces the per-chunk ceiling; nothing bounds how many chunks a run
  can enqueue in total. **Aggregate-pushdown sources are the one
  already-disclosed exception**: `queryBuilder.ts`'s own header comment
  and `runEtl.ts` both document that a pushed `aggregate` transform runs
  as a single, non-paginated statement capped by `limit`
  (`MAX_CHUNK_ROWS` output *groups*, not source rows) — an existing,
  disclosed v1 limitation already tracked in TODO.md, not a new finding,
  and it caps result groups rather than raw source rows scanned.

---

**Commit status:** this report and the Phase 8 changes it summarizes are
committed (`677d692`, plus `89b299e` for the 8a-only subset); the phase
shipped ahead of this exit-doc's own review/sign-off, which does not
match the "held for review, not committed" convention
`PHASE6_EXIT.md`/`PHASE7_EXIT.md` describe. Recorded here as a process
note for future phases, not as an outstanding action item.
