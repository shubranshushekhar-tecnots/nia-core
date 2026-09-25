# Session checks (2026-09-25) — verbatim task list

Saved verbatim per user instruction, so it survives context compaction.
Report each task separately in chat. Don't commit anything from these tasks
unless separately instructed.

## Task 1
`git stash list`: is the "connector dockerfiles - review later" stash still
there? Diff it against the current uncommitted connector Dockerfile changes
(the packages/db COPY/build/hash fix). Same fix or different? If redundant,
say so. Don't pop or drop it.

## Task 2
Where does apps/web import dotenv, and what file does it load? Confirm it
can never load or override env in the production container. If it can, make
it dev-only and report the change.

## Task 3
Commit e034e00: does @nia/secrets now read nia_secrets via the pg driver?
List every remaining runtime use of SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
/ @supabase/supabase-js outside apps/worker/scripts/. If none, say the
containers no longer need them. List any statements in CONVENTIONS.md,
TODO.md and DEPLOYMENT.md that are now wrong (don't fix yet). Don't remove
the two vars from production.env until confirmed by the user.

## Task 4
Prove the connector fix end to end: build the three connector images plus
api (native, one at a time). Boot throwaway Postgres, redis, api and the
three connectors only. Create one connection whose credentials go through
nia_secrets, and hit /test and /introspect through the api so each connector
actually decrypts a secret. A healthy /health is not enough. Report
`docker stats --no-stream`. Tear down.

## Task 5
Only after Task 4 passes: boot web + proxy + api + redis + throwaway
Postgres (no connectors, no worker) and send one real chat/Copilot request
through niacore-proxy. Confirm SSE events arrive incrementally and a long
stream isn't cut off. Report timings. Tear down.

## Local testing rules (already in CONVENTIONS.md, restated here for
convenience — see CONVENTIONS.md's "Local testing (Docker boot tests)"
section as the source of truth)
This machine's Docker Desktop crashes at ~4.6 GB memory pressure:
- Native platform builds only (no `--platform linux/amd64` locally — that
  flag is only for images actually pushed to the registry/x86 server).
- Build one image at a time, never in parallel.
- Ask the user to stop the dev sandbox before booting a test stack — never
  stop it yourself.
- Boot only the services the specific test needs.
- Report `docker stats --no-stream` after boot.
- Always tear everything down when the test is done.
