-- 0030_staging_objects_destination_kind.sql
-- Orphaned-destination-table lifecycle fix (schema-layer Part 4 follow-up):
-- a run that creates its destination table via ensureDestination() and
-- then fails terminally before any successful apply currently leaves that
-- table behind forever — Nia has no record of having created it. This
-- widens staging_objects' `kind` check constraint to also allow
-- 'destination' rows, registered by runEtl.ts right after a successful
-- ensureDestination() call that reports `created: true` (never for a
-- pre-existing destination the run merely writes into). failStaged looks
-- this row up on every terminal pre-apply failure and, if an active row
-- exists for the run, dispatches a signed /drop-entity call and marks it
-- dropped — the same "only ever drop names this table recorded" guarantee
-- staging/quarantine already have.
--
-- Unlike 'staging' rows, a 'destination' row is never swept by the 24h
-- sweeper (staging_objects_sweep_idx's partial index stays scoped to
-- kind = 'staging' only) — a destination table that has already received
-- successfully-applied data must never be touched by a background sweep;
-- only an in-run terminal failure (found via failStaged, before any
-- successful apply) ever drops one.

alter table public.staging_objects drop constraint staging_objects_kind_check;
alter table public.staging_objects add constraint staging_objects_kind_check
  check (kind in ('staging', 'quarantine', 'destination'));

comment on column public.staging_objects.kind is
  'staging: per-run table dropped after a successful apply or a terminal '
  'run failure. quarantine: long-lived per-destination-database sink '
  'table, never swept by the 24h staging sweeper. destination: the run''s '
  'own destination table, registered only when ensureDestination() '
  'actually created it (never a pre-existing one) — dropped by failStaged '
  'on any terminal failure before a successful apply, never swept.';
