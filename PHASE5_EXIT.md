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
