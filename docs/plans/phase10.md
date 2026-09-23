Phase 10 plan: the profiler. First, save this entire prompt verbatim to docs/plans/phase10.md, and re-read it if your context is compacted. Move fast: implement as written, and keep tests to the listed ones. Don't commit.

Step 0: Confirm Phase 9 is committed. The only uncommitted changes should be the known apps/web landing-page work (landing components, Logo, middleware.ts, app/dev/, hero-canvas). Don't touch, stage, or commit those. STOP if anything else is uncommitted, or if a file this phase needs to edit is in that landing-page set.

Step 1: DECIMAL scope check
Check whether the MySQL connector returns DECIMAL as strings on every read (driver config, e.g. mysql2 decimalNumbers, plus a plain extract of a DECIMAL column).
- If connector-wide: fix it the same way the node-postgres NUMERIC bug was fixed (float64, consistent with the documented numeric-precision constraint). Remove the Phase 9 DECIMAL XFAIL, run that tag, record it in decisions.md as a found bug, then continue.
- If limited to the aggregate pagination path: record that and continue.

Step 2: Short inventory (report, then continue)
- How source schemas are introspected today: column names, declared types, primary key.
- The worker's job mechanism for ETL runs, and how the web app gets job results.
- Where a source node's config panel lives in apps/web.

Step 3: Design (implement as written)
A. Sampling
- Profile the first 5,000 and last 5,000 rows by primary key (keyset, both directions), or the whole table if smaller. Record the sample method and size in the profile.
- Values the sample misses are caught at run time by onFailure (default 'fail'). Note this in decisions.md.

B. Stats
Compute in the worker with the residual evaluator and the existing op functions, not separate heuristics. Per column:
- Declared type (from the source schema) and observed value types
- Sample row count, NULL count, empty-string count, whitespace-only count
- Distinct count within the sample
- Missing-value tokens: count of values that, trimmed and case-insensitive, match one of N/A, NA, null, none, nil, -, ?, #N/A (one constant)
- Text columns: parse rates for to_number, to_integer, to_boolean, to_date, and parse_date for each candidate format (ISO date, DD/MM/YYYY, MM/DD/YYYY, YYYY/MM/DD), each with up to 3 failing example values
- Numeric and date columns: min and max
- Text columns: min and max length
Example values are the only raw data stored: at most 3 per stat, each truncated to 50 characters.

C. Signature and hash (used for drift from Phase 13)
- Coarse signature per column: name, declared type, null presence (none/some/all), missing-token presence (yes/no), and an all/some/none bucket for each parse function.
- profile_hash = hash of the canonical signature. Exact counts must not affect it: adding rows of the same shape keeps the hash; a column gaining its first unparseable value changes it.
- Don't wire run-time drift refusal yet. Add it to TODO.md for Phase 13.

D. Cache
- New additive migration: a source_profiles table keyed by (connection, entity, source schema hash), with sample method, sample size, profiled_at, stats (jsonb), signature (jsonb), and profile_hash.
- RLS scoped to the organization, following the existing tables' pattern.
- Reuse a cached profile when the schema hash matches and it's under 24 hours old; otherwise re-profile. Add a manual refresh.
- Run profiling as a worker job through the existing job mechanism.

E. UI
- Add a Profile tab to the source node's config panel: one row per column with declared type, null %, distinct count, missing tokens, parse rates, and failing examples, plus profiled_at, sample size, and a refresh button. Use existing theme tokens and panel patterns. Keep it plain.

Step 4: Tests (minimal; this is the full list)
- Unit test: stats for one fixed in-memory sample containing numbers-as-text with a currency symbol, "N/A", blanks, NULL, whitespace-only values, and dates in two formats. Assert the stats.
- Unit test: the hash is unchanged when same-shape rows are added, and changes when a column gains its first unparseable value.
- One smoke script, smoke:profile: seed the same messy table in the sandbox mysql, postgres, and mongo, profile each, and assert the profiles match (declared type names excepted).
- Typecheck all four packages. Run the schemas and worker unit suites, and web's if it has one. No full agreement suite: this phase doesn't touch the compile path.

Step 5: Close Phase 10
- docs/decisions.md: one short Phase 10 entry.
- docs/history/PHASE10_EXIT.md: short. What shipped, bugs found, open risks.

Output: step 1 and step 2 findings, any deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.
