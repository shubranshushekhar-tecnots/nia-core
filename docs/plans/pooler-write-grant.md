Save this prompt verbatim to docs/plans/pooler-write-grant.md. Don't commit.

Bug found in production testing. Destination = Supabase via the session pooler (*.pooler.supabase.com:5432). The write-grant flow minted role nia_write_fedee56a; clicking "I've run this — confirm access" fails with:
(ENOIDENTIFIER) no tenant identifier provided (external_id or sni_hostname required)
Supavisor requires the username as <role>.<project_ref>. We connect with the bare role name.

Step 0 — clean tree. STOP if dirty.

Step 1 — Inventory (file:line), no changes:
1. Where the minted write role's credentials are used to connect (confirm step, freshness/test, actual writes) and which service runs it (api, worker, connector-supabase).
2. Same for the read-only role flow. Why does the source connection work? Does the user-entered username already carry .<project_ref>?
3. Where the project ref could come from: the connection's original username (postgres.<ref>), the host, or stored connection fields.
4. The grant SQL for nia.nia_quarantine: it ENABLEs RLS with no policies, and the nia_write_* role isn't the owner. Confirm whether that blocks the role's SELECT/INSERT/UPDATE/DELETE. Check the same pattern anywhere else in grant SQL (read-only role, staging tables).

Design (decided, unless Step 1 shows it's wrong — then STOP):
- One helper: if the host is a Supabase pooler (*.pooler.supabase.com), connect as <role>.<project_ref>, with the ref taken from the connection's original username. Use it everywhere a minted role connects (read and write). Non-pooler hosts unchanged.
- If the project ref can't be determined, fail with a clear message telling the user to use the pooler connection string that includes the ref — never silently connect wrong.
- nia_quarantine: fix so the write role can use it (e.g. add policies for that role, or don't enable RLS on this Nia-owned table). Pick the smaller safe fix and explain.

Tests (minimal): unit test for the username helper (pooler host with ref, non-pooler host, missing ref → clear error). Typecheck every package.

Close-out: list which images need rebuilding because of this change. Record in docs/decisions.md.
