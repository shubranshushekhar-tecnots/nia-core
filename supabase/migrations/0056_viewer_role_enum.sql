-- 0056_viewer_role_enum.sql
-- Subscription Phase 2, Slice 3 ("Viewer role"), Migration A. Postgres
-- forbids using a newly-added enum value in the same transaction that adds
-- it (each migration here runs in its own transaction, per
-- scripts/migrate.mjs), so the enum value alone is split into its own
-- migration first — exact same two-migration shape as
-- 0003_owner_enum_value.sql / 0004_owner_rename.sql did for 'owner'.
-- Migration B (0057_viewer_role_restrictions.sql) does everything that
-- actually references this value.

alter type public.org_role add value if not exists 'viewer';
