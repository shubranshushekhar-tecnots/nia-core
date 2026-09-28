Save this prompt verbatim to docs/plans/learning-mode-discovery.md. Discovery only — don't change any code. Don't commit.

Goal: we're planning in-context help ("learning mode") for the steps where users get stuck, starting with connecting a source/destination and granting access. Before designing, find out exactly what exists today in those steps.

Step 0 — Report git status. Don't stop if dirty.

Step 1 — Inventory (file:line for everything). If something doesn't exist, say "not found".

1. The connection flow, end to end, per connector (Postgres/Supabase, MySQL, MongoDB): every screen/step a user goes through (add connection → test → read-only role SQL → grant write access → confirm), with the component that renders each.
2. Existing help text in those steps: labels, placeholders, hints, tooltips, "why" copy, links to docs, empty states. Quote the actual text for each step.
3. The SQL/instructions shown to users (read-only role, write grant): how they're generated, whether they're per-connector, and whether there's a copy button and a "verify it worked" action.
4. Error handling in those steps: list every error a user can hit there (connection test, auth, network/timeout, pooler/ENOIDENTIFIER, SSL, missing grant, RLS, confirm-access failure). For each: where it's produced, the exact message shown to the user today, and whether it includes a plain-language explanation or fix.
5. Any existing help infrastructure: help panels, docs pages, onboarding/tour code, "getting started" checklist (the new home page one), feature flags, a help content store, i18n/copy files.
6. Copilot hooks: can the Copilot currently receive "which step/node/error the user is on" as context? What does /explain (explain_last_error) already know? Could a "help with this step" entry point reuse it without backend changes?
7. Analytics/telemetry: is there any event tracking today (step viewed, test failed, time on step)? If not, say so.
8. Accessibility of those steps: keyboard use, focus handling, screen-reader labels on the forms and the SQL blocks.
9. Anything planned about help/onboarding/docs in TODO.md, docs/plans/, docs/decisions.md, docs/history/, designs/.

Report as:
(a) The current flow per connector, with the help and error text users actually see today.
(b) The top places users are likely to get stuck, ranked, with evidence (confusing copy, raw technical errors, missing steps).
(c) What we can reuse (components, Copilot context, checklist, content).
(d) Open questions for me.
Then stop and wait.
