-- 0026_clean_plan_contract_hash.sql
-- Schema-layer Part 4 — "the contract's hash joins the CleanPlan bindings"
-- (docs/plans/schema-layer.md). Additive, nullable: existing rows (bound
-- before Part 4 shipped) simply have no contract hash yet. See
-- packages/schemas/src/cleanPlan.ts's CleanPlanRecord.contractHash doc
-- comment for why nothing writes this column yet — it's storage ahead of
-- a future apply-time write path, same posture as nodeConfig.ts's
-- SourceDestConfig.contractHash for manual (non-CleanPlan) pipelines.

alter table public.clean_plans
  add column contract_hash text;
