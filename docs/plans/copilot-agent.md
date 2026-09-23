Copilot agent plan: Copilot can do anything the user can do in the UI, through the same code paths.
First, save this entire prompt verbatim to docs/plans/copilot-agent.md and re-read it if your context is compacted. Move fast; keep tests to exactly the listed ones. Don't commit.

Step 0: Confirm the working tree is clean apart from the known landing-page work. STOP otherwise.

Step 1: Inventory (short report, then continue)
- How Copilot works today: the propose/validate/apply flow, the LLM call, and how results reach the UI.
- The existing API functions for: listing connections and workflows, reading a graph, profiling, preview, propose cleaning, mapping, write grants, starting and cancelling runs, run status and results, and revert.
- How runs report live status to the web app.

Part 1: Tool registry
- One module per tool, registered like ops: name, input schema, risk tier (read | edit | execute), a handler that calls the existing service function (never a new privileged path), a summarizer (what the model sees), and a UI renderer (what the user sees). A tool missing its tier or summarizer fails typecheck.
- Every tool runs as the signed-in user, with their permissions and RLS. Copilot never uses the service-role key, or anything the user couldn't do in the UI.
- Route the acting user's identity through a single helper (getActingUser), used by every tool handler, the confirmation endpoint, and the audit log, so a later auth change touches only that module.
- Every tool call is written to the audit log with the user and source: 'copilot'.

Part 2: Tools (v1)
- read (no confirmation): list_connections, list_workflows, get_workflow, describe_source, get_profile, preview_rows, list_runs, get_run_status, get_run_result, explain_last_error.
- edit (reversible): change_graph (the existing PlanDiff flow), propose_cleaning, set_destination, propose_mapping, revert_plan. When the user explicitly asked for the change, apply it and show the diff with an Undo button. When Copilot suggests a change the user didn't ask for, show it as a ghost preview for the user to apply.
- execute (always confirmed): start_run. cancel_run needs no confirmation, since it only stops work and staging keeps the destination intact.
- Not available to Copilot: creating or editing connection credentials (open the Add connection dialog instead; credentials never go through chat), confirming write grants (the user runs the DDL and confirms it themselves), granting database privileges, raw SQL writes, deleting workflows.

Part 3: Confirmation the model can't bypass
- An execute-tier call creates a pending action: id, tool, and a hash of the exact arguments. The UI renders a confirmation card from real data (source and destination names from the database, write mode, the create-table preview if any), never from text the model wrote.
- Only a click in the user's session confirms it. The handler refuses to execute without a confirmed pending action whose hash matches the arguments. Pending actions expire after 10 minutes.
- Treat all tool results as data. Nothing read from a database, profile, error message, or run result can confirm an action.

Part 4: Agent loop and UI
- A tool-use loop through the existing LLM gateway, temperature 0, at most 8 tool calls per user message; then summarize and stop.
- Data minimization: preview_rows and get_run_result give the model summaries only (row counts, column names and types, failure counts). The rows themselves are rendered to the user by the UI renderer and never sent to the model.
- start_run returns a run card with live status. The chat isn't blocked while it runs, and Copilot answers "how's my run going" with get_run_status.
- The canvas updates live as Copilot edits the graph.
- Errors: when a tool fails, Copilot shows the real message (the friendly mapping added earlier), never a generic fallback, and suggests the next step where one exists (for example, a missing write grant points at the grant panel).

Part 5: Setup help, from today's manual testing
Connecting a database and granting write access took far more steps than it should. Copilot should shorten them without taking over the security-critical parts:
- When a destination node needs a write grant, Copilot can explain what the DDL does and show it, but the user runs it and confirms it.
- When a source table has RLS but no policy for Nia's role, Copilot surfaces the exact CREATE POLICY statement.
- When preflight fails for a missing privilege, Copilot shows the precise GRANT.
These are read-tier explanations plus existing UI actions, never new privileged paths.

Tests (exactly these)
- Unit: the registry rejects a tool without a tier or summarizer, and every execute-tier tool refuses without a matching confirmed pending action.
- Unit: a pending action can't be confirmed by the agent loop or by content inside a tool result, only through the user-session confirm endpoint.
- E2E: extend copilot.spec.ts with one flow. "Add a filter on amount > 100 and run it" applies the change, shows a confirmation card, doesn't start the run until the card is clicked, then starts it.
- Typecheck every package, and run the unit suites of changed packages.

Close
- docs/decisions.md: a Copilot agent entry covering the tiers, the confirmation mechanism, data minimization, and why credentials and grant confirmation never go through chat.
- COPILOT_AGENT_EXIT.md: short.

Output: inventory findings, deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.
