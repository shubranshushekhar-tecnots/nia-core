# Phase 5 Exit Report (skeleton — in progress)

This file is created as a stub during Session 4 to hold Phase 5's open
exit risks as they're identified session by session. Fill in the full
exit report (golden-suite results, RLS probes, e2e battery, sign-off)
once all Phase 5 blocks are closed — follow `PHASE4_EXIT.md`'s structure
as the template.

## Open exit risks

- **Chat first-token latency (<3s bar unmet).** p50 ~7.8s / p95 ~8.1s as
  of Session 4 (`apps/web/latency_hops.mjs`, 10 runs), down from Phase 4's
  p50 8.4-8.6s / p95 12.3-12.6s but still well over the original <3s
  target. Root cause: two sequential LLM calls (query-gen then
  answer-gen), each paying a provider inference-start floor. Not waived —
  see `docs/decisions.md`'s "Chat first-token latency" entry for the full
  ruling and the optimization levers to evaluate before Phase 5 exit
  (faster model tier for query-gen, streaming/early-start of answer
  generation, schema-context caching, skip-rewrite fast path for simple
  single-source queries). Re-measure after any lever; target ≤5s p50,
  aspiration ≤3s.

- **No explicit source entity/table selection (Phase 6 BLOCK-0
  PREREQUISITE).** Source nodes persist no entity selection today —
  `SourceDestConfig` has no `entity` field, and the mapping/pushdown
  stack operates on a flat, deduplicated union of every entity's field
  names for a connection (`proposeMapping.ts`'s `uniqueFieldNames`). That
  was harmless while nothing executed a read against the source. Session
  5's destination-node preview (Block 1) is the first thing that does,
  and bridges the gap with `packages/schemas/src/entityResolution.ts`'s
  `resolveSourceEntity()`: it infers the single source table by finding
  the entity whose field set is a superset of the approved mapping's
  `from` fields, failing closed (`entity-unresolved`) on zero or multiple
  matches rather than guessing. **This inference bridge is preview-only
  and is explicitly NOT sufficient for Phase 6's ETL runner** — a real
  run cannot infer its source table by name-matching against whatever
  fields happen to be mapped; it needs an explicit, persisted selection.
  Required before Phase 6 execution work starts: a persisted `entity`
  field on `SourceDestConfig`, a drawer picker for it, and migrating
  `checkMappings`/`proposeMapping`/`pushdown.ts` off the flat union onto
  that explicit selection. Relatedly, `compilePushdown()` has never
  compiled a `FROM`/collection clause (by design — it's a pure fragment
  compiler over one `TransformConfig`); preview's `buildPreviewQuery()`
  supplies `FROM` itself using the resolved entity, without extending
  `compilePushdown()`'s contract. Both gaps close together once explicit
  entity selection lands. Full writeup: `PHASE5_SESSION_NOTES.md`'s
  Session 5 entry; test coverage: `entityResolution.test.ts` (14 cases),
  `runPreview.test.ts`'s two `entity-unresolved` cases.
