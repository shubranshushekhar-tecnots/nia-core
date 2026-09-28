Save this prompt verbatim to docs/plans/learning-mode.md and re-read it if your context is compacted. Read CONVENTIONS.md and docs/plans/learning-mode-discovery.md first. Don't commit.

Goal: in-context help for connecting a source/destination and granting access, starting where users actually get stuck.

Decisions:
- No analytics in this plan. Add to TODO.md: "Minimal first-party event log (step viewed, test failed + error code, help opened). No third-party analytics."
- Persisted run errors / explain_last_error are out of scope (covered by the Console plan's workflow_runs.error step).
- Close the write-grant discoverability gap on /app/connections.
- Help panel reserves a footer slot for a future "Still stuck? Contact support" (not built now).

Step 0 — Tree must be clean. STOP if dirty.

Step 1 — Design proposal, then STOP for my review (no code):

Layer 1 — Read-only user helper (highest priority):
- A per-dialect read-only statement generator in packages/schemas, following the same pattern as writeGrantStatement.ts (Postgres/Supabase, MySQL, MongoDB): create a least-privilege login that can only read the chosen schema/database. Show the exact statements you propose for each dialect, including Supabase specifics (pooler username format user.projectref, RLS implications) — I'll review the SQL before anything is built.
- Where it appears in AddConnectionDialog: a short "why read-only" line, the statement, a copy button, then the existing test. Keep the "I already have a user" path.
- Also on /app/connections: per-connection grant status and a link to where write access is granted.

Layer 2 — "Help with this step" panel:
- Entry points: AddConnectionDialog, EditConnectionDialog, GrantAccessPanel, RevokeAccessPanel.
- Content is hand-written and typed, stored in one place (e.g. packages/schemas/src/help/), keyed by step × connector: what / why / how (numbered) / common problems + fixes. Any SQL shown must come from the same generators as the UI — never duplicated text.
- An "Ask Copilot about this step" button that calls the existing explainer tools (explain_write_grant, explain_source_rls_policy, explain_missing_privilege) with an explicit target (connection id / node id / namespace). Say exactly what context you'd pass and whether any backend change is needed.
- Draft the actual help copy for: add connection (per connector), read-only user, test connection, grant write access, confirm access, revoke access.

Layer 3 — Plain-language errors:
- Wire friendlyConnectionError (or an extension of it) into every uncovered error path from the discovery report (install/uninstall/delete, grant create/revoke, table/schema load, NOT_INSTALLED, MISSING_FIELD, NAME_TAKEN, CONFIRM_FAILED, REVOKE_FAILED, INTROSPECT_FAILED, pooler ENOIDENTIFIER). For each: proposed plain message + fix + link to the matching help section, raw text always behind "Show details".

Accessibility (same steps): Esc + focus trap in Add/Edit dialogs; labels on SQL blocks and table selects; help panel keyboard-reachable.

Deliver: the proposed read-only SQL per dialect, the help-content draft, the error mapping table, UI placement sketches (ASCII), a build order in small steps, and tests planned (including: every step × connector has help content; help SQL equals generator output; every mapped error code has a message). Then STOP. Don't commit.

---

Design approved with these changes. Update docs/plans/learning-mode.md, then start the build order step by step (STOP after each step for review). Don't commit.

SQL (step 1):
1. Injection safety: every user-supplied identifier (database, schema, and anything else interpolated) must be escaped per dialect — Postgres identifiers double any ", MySQL identifiers double any backtick, MongoDB values go through JSON.stringify. Generated passwords use only [A-Za-z0-9]. Unit tests with hostile inputs (quotes, backticks, semicolons, newlines) for all three dialects prove the output stays a single intended statement set.
2. Postgres/Supabase: add `ALTER ROLE "<role>" SET default_transaction_read_only = on;`. Help copy must state that ALTER DEFAULT PRIVILEGES only covers tables created later by the role that ran it; tables created by other roles need the GRANT SELECT ON ALL TABLES line re-run.
3. Schema scope: default public; the read-only helper (not the connection config) accepts optional extra schemas and generates USAGE/SELECT/DEFAULT PRIVILEGES per schema.
4. Supabase pooler: if the pasted connection URL's username is postgres.<ref>, derive <ref> and show/prefill the username as <role>.<ref>. If no ref can be derived, show the existing instruction.
5. MySQL: keep '%' but add a note to restrict the host to Nia's outbound IP when known; drop FLUSH PRIVILEGES.
6. MongoDB: add an "Using MongoDB Atlas?" path — createUser often isn't allowed from mongosh on Atlas; steps: Atlas → Database Access → Add user → built-in role read on <database>.
7. "Use these credentials" button that fills Username/Password with the generated values.

Answers: (1) public default + optional extra schemas in the helper; (2) /app/connections list-only with "Manage from the canvas"; (3) no Ask Copilot on Add/Edit dialogs.

Add the event-log line to TODO.md now.
