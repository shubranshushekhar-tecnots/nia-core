-- 0003_owner_enum_value.sql
-- Adds the new 'owner' value to public.org_role, split into its own
-- migration because Postgres forbids using a newly-added enum value
-- (in policy expressions, updates, etc.) inside the same transaction
-- that added it, and each migration file runs in its own transaction.
-- The actual rename (backfill + policy/helper rewrites) is in the next
-- migration, 0004_owner_rename.sql.
--
-- 'super_admin' is intentionally left defined on the enum — Postgres
-- cannot cheaply drop an enum value, and this keeps the change reversible
-- (see 0004 for the rollback note).

alter type public.org_role add value if not exists 'owner';
