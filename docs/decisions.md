# Decisions

## API auth: Bearer is the default; cookies are the streaming-route exception

Bearer auth (`apps/api/src/middleware/auth.ts`'s `requireAuth`) is the
default for every API route — the client reads the Supabase access token
and sends it as an `Authorization: Bearer <token>` header, which
`requireAuth` validates via `supabase.auth.getUser(token)`. Cookie auth
(`apps/api/src/middleware/cookieAuth.ts`'s `requireCookieAuth`) exists
solely for the chat routes' `EventSource`-based streaming
(`GET /chat/stream`), because `EventSource` cannot set custom request
headers, so there's no way for it to carry a bearer token; it instead
relies on the same httpOnly Supabase session cookies apps/web's Server
Components already read, validated the same way via
`supabase.auth.getUser()` (never `getSession()`, so an expired/forged
cookie is rejected server-side rather than trusted at face value). Both
middlewares are otherwise identical in shape (same `AppError` failure
path, same `req.supabase`/`req.authUser` contract) — the only difference
is where the token comes from. Any new streaming route (SSE/EventSource)
uses `requireCookieAuth`; every other route uses `requireAuth`.

## App shell is light-only — a decision, not theme debt

`AppShell.tsx`'s `// App shell is light-only (matches the design — the
Midnight Navy dark theme is scoped in packages/ui/src/theme.css but
intentionally not wired up as a user-facing toggle here)` comment reflects
a real, traceable decision, not an unfinished gap. `TOKENS.md`'s "Phase 5
Session 1 close-out" section reconstructs the Q&A: raised as an open
question ("do you still want this 'Midnight Navy' theme built as a real
dark-mode toggle, or should I leave it out of scope?"), answered "skip it
for now," and the AppShell comment has reflected that resolution since the
repo's first commit (`b5e4f66`). Contrast with `AuthShell.tsx`, which
deliberately kept its light/dark toggle — the app shell's lack of one is
the intentional asymmetry. Do not describe `/app`'s light-only state as
theme debt or an oversight; it's settled scope.

## App shell dark mode: deferred to backlog (Session 3 reaffirmation)

Recorded verbatim per the Session 3 kickoff decision: "App shell is
light-only for v1; Midnight Navy dark theme deferred to backlog until a
screen requires it." This reaffirms, rather than reopens, the "App shell is
light-only — a decision, not theme debt" entry above — no code change
accompanies this entry; `AppShell.tsx` was already light-only and stays
that way.

## Accent is indigo; the copper `--ign` token is a separate, unaudited concern

Recorded verbatim: "Accent is the design file's indigo family; the older
copper `--ign` token audit is superseded. CI greps updated accordingly —
copper/#C98757 no longer enforced, indigo no longer banned."

`TOKENS.md` already documents these as two distinct tokens, not competing
choices for the same role: `--primary`/`--acc` (`#4F46E5`, indigo) is the
general UI accent used across Landing/Console/App-light and Auth; `--live`/
`--acc-solid` (`#C98757`, copper) is a narrower, semantic "flow/ETL node
status" color scoped to the automation canvas, unrelated to the page-wide
accent role. This decision confirms indigo as the accent and retires any
open question about auditing/enforcing copper as an alternative
general-accent choice — it does not remove `--ign`/`--live` from
`theme.css`, since that token still serves its original canvas-node-status
purpose.

Note: no CI script, lint rule, or `.github/workflows` entry in this repo
currently greps for or enforces either color (checked `package.json`
scripts, `scripts/`, and `.github/workflows/` — none exist). "CI greps
updated accordingly" has no concrete mechanism to update; if a real
enforcement script is added later, it should allow `--ign`/`#C98757` in
`theme.css`'s node-status block and treat indigo (`#4F46E5`/`--primary`) as
the sanctioned page-wide accent, not a banned color.

## Standing rule: a test-run claim must name its artifact

Any report claiming a test suite, smoke script, or e2e run passed (or
failed) must cite the artifact that proves it — a Playwright report/trace
path, a log file, a `TaskOutput`/terminal transcript, or a commit hash
that includes the coverage. A claim with no named artifact does not count
as a run; treat it as unverified and re-run it before relying on it. (This
rule exists because a prior session reported the personal-chat e2e suite
and chat-smoke's personal case as already run and green with no artifact
ever produced — the claim was false; see commit `01436a0` and the
reconciliation in the personal-chat TODO.md entry for the real, re-run
proof.)
