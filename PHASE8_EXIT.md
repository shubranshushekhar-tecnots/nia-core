# Phase 8 Exit Report — DRAFT

**Status: DRAFT, not final.** Phase 8b-3 (per-node `onFailure`/quarantine
behavior) is explicitly still open and out of scope for this report — this
covers 8a (op registry) and 8b-2 (DAX-derived function-vocabulary batches
0-6 plus their hardening follow-ups) only, i.e. everything through batch
6's regex-flavor follow-up closed out in this session. Held uncommitted
for review, same as prior exit reports (see §11) — **not committed.**

All of Phase 8's work (8a onward) exists only as uncommitted working-tree
state except a single early commit, `89b299e` ("Phase 8a: op registry +
dialect adapter seam", preceded by `c433b61`). Everything from 8b-1
(Expr grammar) through this session's Item 2/3 closeout is still sitting
in the working tree, matching this report's own held-for-review status.

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
1. **Guardrails SQL-reconstruction corruption** (8b-2a) — the token-
   rejoining `bodyText` reconstruction, driven by an operator allowlist
   (`MULTI_CHAR_OPERATORS`), didn't know about `<>`/`!=`/`<=`/`>=` and
   inserted stray whitespace inside them, corrupting every dispatched
   mysql/postgres query using one. Found via the `aggregate/mysql` and
   `aggregate/postgres` "having can also reference a groupBy field"
   fixtures failing at dispatch with real native syntax errors.
2. **Postgres CASE-branch literal typing** (8b-2a) — a `computed_field`
   op with numeric-literal conditional branches came back as strings on
   Postgres but numbers elsewhere.
3. **Cross-fragment `arg(n)`/params desync** (batch 5 follow-up 1) — the
   6th live instance of an `arg(n)`-after-intermediate-SQL desync pattern
   and the first **cross-fragment** one (a helper computing one
   sub-fragment's params before a sibling fragment's own params were
   pushed, silently misaligning positional placeholders). Fixed via
   `ParamSink`, a centralizing param-push abstraction.
4. **8 semantics-homogenization divergences** (8b-2b) across mysql/
   postgres/mongo/residual on identical seed data — closed via 5 targeted
   fixes, 0 left as declared-and-accepted.
5. Additional divergences found and fixed during the "3 approved fixes"
   pre-batch-5 hardening pass, plus 2 more surfaced and fixed as a direct
   consequence of fixing those 3 (per the "every pattern-audit in this
   phase has turned up something" working assumption, which held again).
6. **`::` cast guard gap** at batch 0 remainder, and two further
   MULTI_CHAR_OPERATORS-adjacent gaps discovered later in the session
   (`::` itself, then `~*`/`||` in batch 6) — the recurrence of this exact
   bug SHAPE across 3 separate operators is what motivated this session's
   Item 2 work to eliminate the allowlist-based approach structurally
   rather than patch a 4th instance.

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
| 1/2 (Math) | `divide, round, round_up, round_down, abs, ceil, floor, round_to_multiple, mod, power, sqrt, sign, quotient, int, trunc, exp, ln, log` | all pushable, all dialects |
| 3 (Text) | `trim, left, right, mid, len, substitute, find, rept, split, contains, is_null, is_not_null` | all pushable, all dialects, **except** `upper`/`lower`: `mongo: false` (residual-only there) |
| 4 (Coercion) | `to_number, to_integer, to_text, format_number, to_boolean, to_date` | all pushable, all dialects |
| 5 (Date-part) | `year, month, day, hour, minute, second, quarter, weekday, date_diff, date_add` | all pushable, all dialects |
| 6 (Cleaning) | `regex_match` | all pushable, all dialects |
| | `regex_extract` | `mysql: false` (mysql lacks a native group-index-capable regex-extract construct; residual there) |
| | `regex_replace` | `mongo: false` (residual there) |
| | `canonicalize` | `mongo: false` (residual there) |
| | `strip_accents` | **all dialects false** — residual-only, no pushdown anywhere |
| | `parse_date`, `parse_number` | all pushable, all dialects |

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

## 7. Files changed this phase (uncommitted working tree)

24 tracked files modified, 12 new untracked files (scripts +
`paramSink.ts`), per `git diff --stat` / `git status --porcelain` at the
time of this report:

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

**New live-harness scripts (untracked):**
`apps/worker/scripts/ops-agreement.ts`, `ops-db-conformance.ts`,
`lib/agreementCases.ts` + `lib/` support, plus a set of narrow one-off
probe scripts (`bigint-precision-probe.ts`, `collation-probe.ts`,
`date-literal-cast-probe.ts`, `date-part-fn-probe.ts`,
`mongo-date-fn-probe.ts`, `month-add-clamp-probe.ts`,
`numeric-precision-probe.ts`, `tmp-mixed-branch-probe.mjs`).

**Docs:** `docs/decisions.md` (+2786 lines this phase — the full session
log this report summarizes), `TODO.md` (+61).

**Unrelated to this phase, pre-existing in the working tree:**
`designs/background.mp4` deletion, `apps/worker/package.json` script
additions (the smoke-script wiring referenced in §5), `apps/web/
tsconfig.tsbuildinfo` (build artifact, not source).

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

---

No commit has been made for this report or the Phase 8 working-tree
changes it summarizes — held for review, matching this repo's established
exit-report convention (see `PHASE6_EXIT.md`/`PHASE7_EXIT.md`).
