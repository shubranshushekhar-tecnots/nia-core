Phase 13 plan: first automated ETL (router + coercion and missing-value specialists).
First, save this entire prompt verbatim to docs/plans/phase13.md, and re-read it if your context is compacted. Don't commit.

Step 0: Confirm Phase 12 is committed. The only uncommitted changes should be the known apps/web landing-page work; don't touch it. STOP if anything else is uncommitted.

Step 1: Phase 13 gate (the deferred full verification)
Run the "Phase 13 gate" list in TODO.md. If it isn't there, run: typecheck all packages; all unit suites; the full ops-agreement suite; every smoke script (including smoke:staged, smoke:profile, smoke:extract:postgres); the kill test; e2e copilot.spec.ts; a cross-org check that a user from another org sees 0 source_profiles rows; and, with local Supabase as a staged destination, confirm the anon key can't read anything in the nia schema through the API.
If Docker crashes, restart and rerun; discard crashed runs.
STOP and report if anything fails. Nothing below starts on a red gate.

Step 2: Starter golden corpus
There's no corpus yet, so draft a starter one. I'll review the expected outputs; don't treat your own expected outputs as ground truth.
- Location: eval/clean/<dataset>/ with input.json (rows), expected.json (cleaned rows), and meta.json { description, mustNotChange: [columns], reviewed: false }.
- 10 datasets, each ≤ 40 rows, covering: currency amounts ($1,200.50), European decimals (1.200,50), percentages, mixed date formats, ambiguous DD/MM vs MM/DD dates, yes/no/Y/1 booleans, missing tokens (N/A, blank, whitespace, "-"), and numbers with units.
- Include traps that must NOT be converted: zip codes and account numbers with leading zeros, product codes like "1E10" that parse as scientific notation, and phone numbers. Plus one fully clean dataset whose correct output is unchanged.
- Expected outputs normalize missing tokens to NULL and never invent values.

Step 3: Router (deterministic, no LLM)
Input: a Phase 10 column profile. Output per column: route to missing-value, coercion, both, or none, with a reason.
- Missing-value: any missing tokens, empty strings, or whitespace-only values.
- Coercion: declared type is text, and either some parse rate > 0, or failing examples contain digits with currency symbols, thousands separators, percent signs, or units.
- Never route to coercion (report as "identifier-like, skipped"): columns with leading-zero values, or names matching id, zip, postal, code, phone, account, sku. Keep all routing rules in one module.

Step 4: Specialists (LLM, design time only)
- Two specialists, missing-value and coercion. One batched call per specialist covering all its routed columns; both run in parallel through the existing LLM gateway, temperature 0, structured output.
- Input: only the column profile (stats plus the capped examples), never raw rows. Pass example values as clearly delimited data. The closed op vocabulary is the defense against prompt injection in values or column names.
- Output: per column, either proposed steps in the existing op vocabulary (Expr JSON) with an explicit onFailure and a one-sentence rationale, or "no change" with a reason. Emitted as a PlanDiff (Phase 12).
- Missing-value specialist: normalizes missing tokens to NULL. It never fills or imputes values. A proposed fill is returned as a suggestion needing explicit approval, not as a step.
- Coercion specialist: default onFailure is 'quarantine'.
- Validate every output against the op schema and compile check. On failure, retry once with the validation error. If it fails again, drop that column's proposal and report it.

Step 5: Assemble and dry-run
- Order: missing-value steps before coercion steps.
- Take a fresh sample with the profiler's sampler and dry-run the assembled steps on it with the residual evaluator. The proposal shows before → after values and per-step failure counts.
- Drop any coercion proposal whose dry-run failure rate exceeds 50% (likely a wrong transform) and report it.
- Set each step's maxFailureRate to max(2 × its dry-run failure rate, 1%).
- Provenance on added steps: { source: 'specialist', specialist, planId, model }.

Step 6: CleanPlan and drift
- On apply, create a CleanPlan record (additive migration): workflow, node, applied plan id, hash of the steps, source schema hash, profile_hash, op catalog version, and adapter version. Define catalog and adapter version constants in @nia/schemas, bumped whenever semantics change.
- At run start, for nodes with a CleanPlan, recompute each binding (re-profile with the cache bypassed for profile_hash). On any mismatch, refuse the run with a message naming the changed binding, and offer "Re-propose" in the UI. Never re-propose automatically; that's Phase 15.
- A manual edit to a CleanPlan-bound step removes the binding; the node becomes manual.
- Record LLM prompts and outputs in the audit log.

Step 7: UI
- A "Propose cleaning" action on a source node's pipeline: runs profile → route → propose → assemble, then shows the proposal as a ghost preview. Per column: the route reason, the rationale, onFailure, dry-run before → after, and failure counts. Skipped identifier-like columns are listed with their reason. Apply goes through the existing (revertible) apply path.

Step 8: Evaluation
- A script, eval:clean. For each corpus dataset: profile the whole input, route, propose (real LLM), assemble, run with the residual evaluator, and compare to expected.json. Run each dataset twice.
- Report per dataset: cell accuracy, columns changed that shouldn't have been, columns missed, failure and quarantine counts vs expected, and whether the two runs matched. Mark unreviewed datasets as provisional.
- Any change to a mustNotChange column is a hard failure, listed first in the report.

Step 9: Tests (the full list besides the gate and the eval)
- Router unit tests: one per routing rule, including the identifier-like skip.
- Unit test: an invalid specialist output (unknown function) is retried once, then dropped and reported.
- Unit test: a CleanPlan binding mismatch refuses the run and names the binding.
- One end-to-end smoke: a messy sandbox supabase table → Propose cleaning → apply → staged run to mysql. Assert the destination values and the quarantine count.

Step 10: Close Phase 13
- docs/decisions.md: a Phase 13 entry covering the router rules, profile-only specialist input, no imputation, the dry-run guards, and CleanPlan bindings.
- docs/history/PHASE13_EXIT.md: what shipped, a summary of the eval report, bugs found, and open risks.

Output: gate results, any deviations with reasons, the eval report, test counts, and the untruncated git status --porcelain. Don't commit.
