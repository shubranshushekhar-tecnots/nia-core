-- 0025_clean_plan_profile_signature_version.sql
-- Adds profile_signature_version to clean_plans, alongside op_catalog_version
-- and adapter_version (0024_clean_plans.sql). See
-- packages/schemas/src/cleanPlan.ts's PROFILE_SIGNATURE_VERSION doc comment:
-- this lets the run-start drift check (apps/worker's cleanPlanDrift.ts)
-- distinguish "the profile hash format itself changed" from "the same-format
-- profile hash no longer matches" (actual data drift), instead of a format
-- change surfacing as a misleading data-drift refusal.
--
-- Backfilled to 1 (the version in effect when this column is introduced) for
-- any existing bound rows, so no pre-existing CleanPlan is spuriously
-- refused the moment this migration lands. Default kept (matches
-- 0016_write_grants.sql's cred_version precedent) so future inserts that
-- omit it don't fail — application code always sets it explicitly anyway.

alter table public.clean_plans
  add column profile_signature_version integer not null default 1;
