Phase 12 plan: the diff model (edit and delete applied plans). No LLM changes in this phase.
First, save this entire prompt verbatim to docs/plans/phase12.md, and re-read it if your context is compacted. Move fast: implement as written, and keep tests to the listed ones. Don't commit.

Step 0: Confirm Phase 11 is committed. The only uncommitted changes should be the known apps/web landing-page work; don't touch, stage, or commit it. STOP if anything else is uncommitted.

Step 1: Short inventory (report, then continue)
- The current Copilot plan format: which operation kinds exist (add node, add edge, config changes?), and whether any can modify or remove existing elements.
- How apply validates, bumps graphVersion, and writes the audit entry.
- What's stored for an applied plan today.
- How ghost preview renders a plan.
- Whether transform steps have stable IDs and any provenance field. If they lack stable IDs, add them (generated at creation, assigned on read for existing steps) and continue.
- How the roadmap or TODO.md defines Phase 12. STOP if it differs materially from the design below.

Step 2: Design (implement as written)
A. Diff format
- A plan is a list of operations: addNode, removeNode, updateNode, addEdge, removeEdge, addStep, removeStep, updateStep, moveStep. Steps are addressed by stable step ID.
- Every update and remove stores a full snapshot of the element before the change, and every add and update stores the full element after. No JSON patches.
- removeNode must be accompanied by explicit removeEdge operations for its edges. A diff that would leave a dangling edge fails validation.

B. Apply
- Apply a diff to the graph in memory, then run the existing plan validation on the result (op schemas, compile checks, graph integrity) before saving. Keep the existing graphVersion check as the concurrency boundary.
- Steps added or updated by a plan record provenance: { source: 'copilot', planId }. A later manual edit of that step sets provenance to manual.

C. Revert ("delete an applied plan")
- Revert builds the inverse diff and applies it through the same path: same validation, same graphVersion check, and its own audit entry referencing the original plan.
- Before reverting, check that every element the plan touched still matches the plan's "after" snapshot. If any doesn't, refuse and list the elements that changed since. No automatic merging.
- Mark the original plan as reverted (reverted_at, reverted_by, and a link to the revert). Use an additive migration.
- Plans applied before Phase 12 are not revertible. The UI says so instead of offering the button.

D. Edit
- Editing an applied plan's result is a new diff on top, or a normal manual edit. Applied plans are never rewritten.

E. Copilot and UI
- The plan schema and apply path accept every new operation kind. Don't change Copilot prompts: Phase 13's specialists are the first to emit updates and removals.
- Ghost preview: removed nodes and steps appear dimmed and marked as removed; updated ones show a badge, with before → after values for changed fields in the preview panel.
- Applied plans get a Revert button, with the conflict list shown when a revert is refused. Keep it plain.

Step 3: Tests (minimal; this is the full list)
- Unit test: round trip. Apply a diff containing each operation kind, then revert it; the graph must deep-equal the original.
- Unit test: revert is refused when a touched step was edited after apply, and the error names that step.
- Unit test: removeNode without its removeEdge operations fails validation.
- Apply-path service test: apply a plan, revert it; the graph is restored, graphVersion bumps twice, and there are two audit entries.
- The apply path changed, so run copilot.spec.ts once.
- Typecheck all packages; run the unit suites for the packages you changed.

Step 4: Close Phase 12
- docs/decisions.md: one Phase 12 entry covering the snapshot-based diff, revert-as-inverse, refuse-on-conflict, and why pre-Phase-12 plans aren't revertible.
- PHASE12_EXIT.md: short. What shipped, bugs found, open risks.

Output: step 1 findings, any deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.
