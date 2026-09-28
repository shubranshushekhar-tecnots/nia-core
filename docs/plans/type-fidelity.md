Found in real testing (Supabase → Supabase, new destination table, source public.customers):
1. Source numeric(12,2) → destination created as plain numeric; values arrive as 1.5 instead of 1.50. Suspect values travel as JS numbers (precision risk for large/precise decimals).
2. Source NOT NULL columns (full_name, email, signup_date, is_active) → destination columns all nullable except id.
3. Destination columns created in alphabetical order, not source order.

Step 0 — clean tree. STOP if dirty.

Step 1 — Diagnose (file:line), no changes:
1. Where source column types are read (introspection) — do we capture precision/scale (numeric(p,s), varchar(n), timestamp precision)?
2. How values are read from the source and serialized through the pipeline: does pg parse numeric into JS number anywhere (pg type parsers, JSON serialization, transforms)?
3. ensureDestination / buildRuntimeContract / CREATE TABLE: where nativeType, nullability and column order are decided and why precision, NOT NULL and order are lost.
4. Does the same happen for mysql and mongodb paths (decimal/Decimal128)?
STOP and report before fixing.

Design (decided):
- Numeric/decimal values are never converted to JS numbers anywhere in the pipeline. They travel as exact strings end to end.
- New tables copy the source's exact type including precision/scale (numeric(12,2) stays numeric(12,2)) for same-dialect copies. Cross-dialect uses the closest exact type, never a float.
- NOT NULL is preserved when the source column is NOT NULL.
- Column order follows the source order.
- Don't add unique/foreign-key constraints yet — record them as a known gap in TODO.md.

Tests (minimal): 12345678901234.56 and 1.50 round-trip exactly; numeric(12,2) created as numeric(12,2); NOT NULL preserved; column order preserved. Typecheck every package.

Close-out: files changed, which images need rebuilding. Record in docs/decisions.md. Don't commit.
