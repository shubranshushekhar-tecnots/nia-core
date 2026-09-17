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

## Chat first-token latency: <3s exit bar unmet, not waived — converted to a Phase 5 exit item

Recorded verbatim per the ruling on Session 4's Block 0 re-measurement:
"Chat first-token latency: p50 ~7.8s (two sequential LLM calls at provider
inference-start floor). Original <3s exit bar UNMET and not waived —
converted to a Phase 5 exit item. Shipped because time-to-first-stage p50
~220ms gives immediate visible progress. Optimization levers to evaluate
(Phase 5 exit or Phase 6 sidecar): faster model tier for query-gen
specifically; streaming/early-start of answer generation; schema-context
caching in prompts; skip-rewrite fast path for simple single-source
queries. Re-measure after any lever; target ≤5s p50, aspiration ≤3s."

Session 4 numbers this ruling responds to: p50 7846ms / p95 8089ms
(`apps/web/latency_hops.mjs`, 10 runs), vs. Phase 4's p50 8431-8603ms /
p95 12276-12642ms (`PHASE4_EXIT.md`). Time-to-first-stage-event (not
first-token) is separately p50 ~219-220ms, which is what "immediate
visible progress" refers to above — the UI shows activity within ~220ms
even though the full answer's first token doesn't land until ~7.8s later.

## Phase 5 Session 5, Block 3: latency-lever re-verification, live evidence

Re-checked the four levers this ruling lists, against the plan's specific
requirement to re-verify with live evidence rather than re-reading old
docs. Nothing implemented — all four close out as investigation-only,
consistent with "implement only if cheap and golden-gated," since none
clears that bar. Cross-references `PHASE4_EXIT.md` §4.4 Fix 1-3, which
originally diagnosed these; this entry reconfirms live, today, that
nothing has changed.

**Lever 1 (faster query-gen model tier) — still blocked, reconfirmed live.**
Direct probe against the gateway (`google/gemini-3.5-flash`, bypassing
the worker) reproduces Phase 4's exact finding: `provider_metadata.gateway
.routing` shows the Google BYOK credential failing
(`"API key not valid. Please pass a valid API key.", statusCode: 400`),
falling back to a `vertex` system credential
(`resolvedProvider`/`finalProvider: "vertex"`), which carries a mandatory
~100-150 reasoning-token overhead (`usage.completion_tokens_details
.reasoning_tokens: 149` this run) baked into every Gemini call regardless
of prompt. `usage.is_byok: false` confirms the fallback. Unchanged from
Phase 4; still blocked on the platform-level BYOK credential, not
anything in this codebase.

**Lever 2 (skip-rewrite fast path) — N/A, no-op confirmed.**
`apps/worker/src/lib/chat/nodes/rewrite.ts` is a pure pass-through (emits
its `rewriting` status event and forwards `state` unchanged) — there is
no rewrite work being done for any query shape, simple or complex, so
there is nothing to skip. No code change.

**Lever 3 (schema-context caching) — technically available (undocumented),
zero latency benefit, not implemented.** `.nia/assets/API_REFERENCE.md`'s
documented `/v1/chat/completions` schema lists only `model`/`messages`/
`stream`/`stream_options` — no `cache_control` field. Empirically tested
anyway (per the plan's instruction to check the gateway directly, not
just its docs): an Anthropic-style content-block system message with
`cache_control: {type: "ephemeral"}` against `anthropic/claude-sonnet-4-6`
IS accepted and functional despite being undocumented — first call
produced `cache_creation_input_tokens: 1808`; a repeat call against the
same block produced `cached_tokens: 1808` with a ~89% cost drop
(`0.006873` → `0.0006354`). This is a real, previously-unknown capability
worth a future cost-optimization ledger entry (out of scope here). But a
clean miss-vs-hit latency comparison (fresh salted block to force a real
miss vs. a repeated block to force a hit) showed no measurable latency
difference: miss 4074ms, hits 4360ms / 4005ms — within noise of each
other. This confirms Phase 4's root-cause finding (provider
inference-start floor dominates, not prefill compute) holds for cached
prompts too. Not implemented: it would add real complexity (content-block
message shape, `gatewayClient.ts`'s `ChatMessage.content: string` would
need widening) for a cost win with zero effect on the latency bar this
block exists to move.

**Lever 4 (answer-gen early-start / connection warmup) — already moot,
confirmed live.** The plan's cheap candidate variant is a no-op warmup
fetch fired concurrently with `dispatch()`, on the premise that it primes
the connection for the following answer-gen LLM call. Measured the actual
gap this would need to bridge — `executing` (dispatch) stage-start to
`generating_answer` stage-start, from a separate 10-run `latency_hops.mjs`
probe capturing full per-stage timestamps (relative stage gap, not
compared to the headline totals below, which came from a different run
on a noisier machine state) — and it is 54-113ms across all 10 runs
(min 54, median 89, max 113). Node's built-in fetch (undici) keeps
connections alive by default with a documented `keepAliveTimeout` of
4000ms; the measured gap is 35-70x smaller than that window. The
connection used for the immediately-preceding `generateQuery` LLM call on
the same process/singleton `OpenAI` client (`gatewayClient.ts`) is
trivially still warm by the time `buildAnswer` fires — there is no cold
connection for a warmup to prevent. No code change.

Re-measured with `node latency_hops.mjs` (10 runs, real
`@mysql-dev` connection, chromium via Playwright) after concluding no
lever should be implemented: p50 8517ms / p95 11275ms — within noise of
Session 4's p50 7846ms / p95 8089ms, no regression. Still fails the
original <3s bar; ≤5s p50 target also unmet. Golden set re-run is not
required by the plan's own conditional wording ("full golden set must
hold after any implemented lever") since no lever was implemented.
Latency remains an open Phase 5 exit item, carried forward with this
session's live re-verification as the current evidence.
