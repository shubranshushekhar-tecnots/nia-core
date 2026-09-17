# Phase 6 Session Notes

## Block 1 — Housekeeping: the chaining contract (runner's written contract)

Per the Phase 6 kickoff's ledger item 1a-3: this moves the multi-transform
pushdown chaining contract out of `af00263`'s commit message (Phase 6 Block
0) into a durable, citable doc — the ETL runner (Block 3) must follow this
contract exactly, not re-derive it from a commit message.

**What composes in-dialect vs. what forces residual, precisely:**

`compilePushdown()` (`packages/schemas/src/pushdown.ts`) compiles exactly
ONE node's `TransformConfig` against one source dialect. It walks that
node's `steps` in array order and pushes each step into the compiled
dialect query for as long as the step is pushable
(`isPushable()` — dialect-specific: SQL/Mongo each support a different
subset of `TransformStep` kinds). The **first non-pushable step, and every
step after it in that same node**, becomes residual in-stream work — never
reordered around, since reordering user-authored steps to keep pushing
down would silently change semantics (a later step could in principle be
pushable on its own, but this compiler will not skip ahead to push it).

That single-node contract does NOT extend across multiple transform nodes
on one source→destination path. `compilePushdown()` takes one
`TransformConfig`, not a path — there is no defined way today to chain two
transform nodes' compiled fragments into one dialect query. Phase 5
Session 5 Block 1 (preview) hit this first and resolved it by degrading
honestly rather than inventing chaining semantics under that session's
scope:

- **0 transform nodes** on the path → trivial; no pushdown needed beyond
  the mapping's own projection.
- **Exactly 1 transform node** → normal `compilePushdown()`, single-node
  contract above applies in full.
- **2+ transform nodes** → the ENTIRE path's transforms are treated as
  residual — nothing is pushed down, no `WHERE`/pipeline fragment is
  compiled at all, even if the first node's steps would individually have
  been pushable. `PreviewValue.residualCount` (and the runner's equivalent
  reporting) must report the true residual count so the UI's "N in-stream
  transforms will apply at run time" notice is never misleading about what
  actually executed.

**The runner's obligation (Block 3):** `EtlRunJob`'s "apply residual
transforms in-stream" step must implement this exact same 0/1/2+ split —
resolve the entity first (`entityResolution.ts`), call `compilePushdown()`
for the single-node case, and fall back to fully-residual, in-process
transform application for any path with 2+ transform nodes. This is not a
gap to close inside Block 3; multi-transform pushdown chaining remains
explicitly out of scope (Phase 5 Session 5's decision, reaffirmed at Phase
6 Block 0 — see `TODO.md`'s closed compiler-completeness entry and
`af00263`'s commit message) — the runner only needs to implement the
residual fallback correctly, not build real chaining.

See `packages/schemas/src/pushdown.ts`'s header comment (dialect/fragment
scope) and `PHASE5_SESSION_NOTES.md`'s Session 5 Block 1 entry (original
preview-side discovery and the 0/1/2+ degradation this contract
generalizes from).
