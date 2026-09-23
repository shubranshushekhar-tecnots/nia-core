-- 0022_staging_objects_dest_info.sql
-- Phase 11 (item 12 follow-up) — persists each staging row's destination
-- entity/columns/upsertKeys alongside the staging table's own name, so the
-- 24h sweeper (a background job with no live EtlRunJob/graph context) can
-- reconstruct a valid, grant-checked, signed StageRequest("drop") for a
-- stale row on its own — the same fields runEtl.ts already has in-hand from
-- destConfig/destColumns when it calls dropStaging() directly during a run.
--
-- Nullable, additive: quarantine rows (kind = 'quarantine') never populate
-- these (they're never swept — see 0021's column comment on `kind`), and
-- existing staging rows created before this migration (none in practice;
-- Phase 11 has not shipped yet) simply have them null, which the sweeper
-- treats as "can't safely reconstruct a drop request" and skips rather than
-- guesses.

alter table public.staging_objects add column dest_namespace text;
alter table public.staging_objects add column dest_name text;
alter table public.staging_objects add column dest_columns text[];
alter table public.staging_objects add column dest_upsert_keys text[];

comment on column public.staging_objects.dest_namespace is
  'Destination entity''s namespace (schema/database) this staging row will '
  'apply into — set at registerStagingObject time, kind = ''staging'' only. '
  'Needed by the 24h sweeper to build a signed StageRequest("drop") for a '
  'stale row without any live run/graph context.';
comment on column public.staging_objects.dest_name is
  'Destination entity''s table/collection name — see dest_namespace.';
comment on column public.staging_objects.dest_columns is
  'Destination''s full mapped column list at staging-create time — the '
  'signed WriteContext.columns a sweep-time drop request re-signs with.';
comment on column public.staging_objects.dest_upsert_keys is
  'Destination''s upsert key column(s) at staging-create time — required '
  'by StageRequest.upsertKeys (min 1) even for a drop, which does not '
  'itself use them for DML.';
