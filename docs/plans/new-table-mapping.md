Save this prompt verbatim to docs/plans/new-table-mapping.md. Don't commit.

Bug found in production testing. Destination = Supabase, schema public, NEW table name "customers" (doesn't exist yet). Source = public.customers with 8 columns (id, full_name, email, country, signup_date, is_active, lifetime_value, notes).
In the destination node's Field mapping tab:
- The right-hand "Select field…" dropdown only lists ~257 existing columns from across the whole destination database — clearly Supabase internal schemas (auth, storage, etc.: client_secret, bucket_id, confirmation_token…). None are in public, none belong to the new table.
- There's no way to create a new destination column, so a new-table migration can't be mapped at all.

Step 0 — clean tree. STOP if dirty.

Step 1 — Inventory (file:line), no changes:
1. Where the destination field list comes from (introspection call, filtering) and why it isn't scoped to the chosen schema.table.
2. How the new-table flow is meant to work end to end: is there an existing path where new-table columns are derived from source fields (e.g. the "Infer from mapping…" option, auto-create on first write)? How are destination column types decided, and how is the CREATE TABLE produced?
3. Which introspection excludes system schemas today (pg_catalog, information_schema, auth, storage, realtime, supabase_*, extensions, graphql*, vault, pgsodium, net, cron…) and which doesn't.
4. What Phase 7/8 tests covered for the new-table path, and why they didn't catch this.
STOP and report if the intended design is unclear.

Design (decided unless Step 1 shows an existing intended path — then follow that and tell me):
- Destination field options are scoped to the chosen schema.table only. System schemas are never offered anywhere.
- New table (doesn't exist): mapping defaults to one destination column per source field, same name, type derived from the source type. Each destination name is editable. Nothing from other tables is ever suggested.
- Existing table: options are only that table's columns.

Tests (minimal): the field-list scoping (new table → derived from source; existing table → its own columns only; system schemas excluded). Typecheck every package.

Close-out: which images need rebuilding. Record in docs/decisions.md.
