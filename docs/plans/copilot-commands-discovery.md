Save this prompt verbatim to docs/plans/copilot-commands-discovery.md. Discovery only — don't change any code. Don't commit.

Goal: understand the Copilot's slash-command menu (typing "/" in the Copilot input) before we redesign it. It currently doesn't work properly. What's visible when typing "/": tabs "Command 24 | Skills | AI Command"; items include ask, fix, git, run, dev, plan, test, debug, (one item with a blank label), review, commit, deploy…; a tooltip "…timize Panel Size" overlaps the menu; the list is clipped at the bottom.

Step 0 — clean tree check. Report status, don't stop.

Step 1 — Inventory (file:line for everything):
1. Where the menu lives: component(s), where the command list is defined (static list, config, API?), and how the three tabs (Command / Skills / AI Command) are populated.
2. A table of all 24 commands: name, label, icon, description, what happens when chosen (inserts text? runs a handler? calls the API?), whether the handler actually exists and works, and whether it makes sense for an ETL/workflow product user. Mark each: works / broken / stub / placeholder.
3. The blank-label item: which command it is and why its label is empty.
4. Skills and AI Command tabs: what they contain, where the data comes from, what selecting one does.
5. Interaction: typing to filter, arrow keys, Enter, Tab, Esc, mouse hover/click, what happens after selection (does the "/" text get replaced?), arguments after a command (e.g. "/run workflow-name"), behaviour when the input already has text, and when "/" is typed mid-sentence.
6. Layout: why the list clips, why the tooltip overlaps, max height/scrolling, keeping the highlighted item in view, behaviour on small screens.
7. Accessibility: roles (listbox/option), aria-activedescendant, focus handling, screen-reader labels.
8. How the Copilot receives a chosen command end to end (web → api → worker if applicable), and whether commands respect the propose → preview → apply flow.
9. Existing tests (unit/e2e) covering the menu, and what they check.
10. Every bug or rough edge you find, each with file:line and a one-line cause.

Report as: (a) what's built, (b) what's broken, (c) commands that probably don't belong in this product, (d) open questions for me. Then stop and wait.
