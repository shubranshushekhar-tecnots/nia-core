# Phase 4 Exit Report

Run date: 2026-09-16. Golden-suite run id `bf73a553-4588-43f1-98b8-857846883fc5`
(`apps/worker/eval-reports/latest.json`, started 2026-09-16T04:18:54.223Z,
finished 2026-09-16T04:23:43.502Z). Reproduce with `pnpm --filter @nia/worker
eval:golden` (needs the full sandbox stack up: `docker compose up -d`,
`supabase start`, `apps/worker`'s BullMQ worker running).

## 1. Golden set results

20/20 passed. 0 citation failures. 0 must-refuse failures. Acceptance gate
(≥18 passed, 0 citation/must-refuse failures) — **PASS**.

| case | pass | faithful | latency ms | citations | Langfuse trace |
|---|---|---|---|---|---|
| single-mysql-max | ✅ | true | 13312 | 1 | `91e505b5-eca7-4607-a4f1-de8f25a8cf22` |
| single-mysql-min | ✅ | true | 13965 | 1 | `80ec01fc-e0c7-426f-bbfb-ed8f369f22c5` |
| single-mysql-count | ✅ | true | 12685 | 1 | `243e1405-65d5-45fe-97ab-d1b7b68789f1` |
| single-supabase-lookup | ✅ | true | 11740 | 1 | `fc615b7f-3099-42e8-b549-b65c58c58046` |
| single-supabase-filter | ✅ | true | 16294 | 1 | `ef50435e-8746-472e-80fa-5ebc1f7bd59d` |
| single-supabase-sum | ✅ | true | 23466 | 1 | `54d409b0-3218-4f5e-84ad-8af4318513c9` |
| single-mongodb-max | ✅ | true | 18557 | 1 | `3f85453d-59a6-4df4-bafe-f8a27dd06235` |
| single-mongodb-filter-count | ✅ | true | 19949 | 1 | `8c98573d-6cd4-4420-9279-d3a61475407f` |
| multi-count-mysql-mongo | ✅ | true | 19572 | 2 | `9d809807-ab38-4134-a178-8e163643c38d` |
| multi-count-mysql-supabase | ✅ | true | 18985 | 2 | `d0b20dae-148a-4468-84c3-f389822c384c` |
| multi-count-all-three | ✅ | true | 19227 | 3 | `ce2948fb-93b5-4c7f-804e-20f31c70cb83` |
| multi-sum-mysql-mongo | ✅ | true | 19470 | 2 | `f23a86cc-bb21-4e7b-b7cb-79c6087fdebc` |
| multi-sum-mysql-supabase | ✅ | true | 22615 | 2 | `d3b31d97-d3bb-4d61-bfc4-5186c7e0e607` |
| multi-sum-all-three | ✅ | true | 20260 | 3 | `72110880-d8ac-4191-b68d-df3006002cd8` |
| multi-refusal-unsupported | ✅ | n/a (refused) | 4415 | 0 | `70dd211d-d56e-4ad1-ad03-d2a63b1e7c90` |
| multi-refusal-partial-failure | ✅ | n/a (refused) | 8468 | 0 | `7dbc2364-1571-441f-a86e-44c13a680db8` |
| multi-conflict-max-two | ✅ | n/a (conflict) | 11009 | 2 | `73c9d2b7-6b61-46d4-973b-f09b8f7add56` |
| multi-conflict-min-three | ✅ | n/a (conflict) | 14391 | 3 | `634b6b5a-d7a4-41dc-b9aa-d3a0c5394ac4` |
| needs-scope-1 | ✅ | n/a (refused, pre-graph) | 3 | 0 | `158e407a-f27a-44c3-937f-2f090eedb212` |
| needs-scope-2 | ✅ | n/a (refused, pre-graph) | 4 | 0 | `d9eccf75-c6dd-420a-938a-2adca5ac6254` |

Nightly schedule: `registerNightlyEvalSchedule()` (`apps/worker/src/lib/eval/
schedule.ts`) registers a BullMQ repeatable job (`upsertJobScheduler`, id
`nightly-golden-eval`) on `env.EVAL_NIGHTLY_CRON` (default 03:00 daily),
idempotent across worker restarts. On-demand run: `pnpm eval:golden`
(`apps/worker/scripts/run-golden-eval.ts`), exits non-zero if the acceptance
gate isn't met.

Two real scoring-harness bugs were found and fixed while getting this run
clean (not fixture/question tuning):
- `runGoldenSuite.ts` used a bare `randomUUID()` for `conversationId` with no
  backing `conversations` row, so `persistAssistantMessage`'s FK insert
  silently no-op'd — fixed by adding `createConversation(orgId)` to
  `apps/worker/src/lib/eval/sandbox.ts` and using a real row.
- `contentIncludes()`'s substring check failed on the model's comma-formatted
  numbers (`"$1,395,000"` vs. expected needle `"1395"`) — fixed by stripping
  thousands-separator commas from both sides before comparing, uniformly,
  not by touching any fixture's expected value.

## 2. Citation reproduction

0/20 citation failures. Every case's citations were independently
re-executed (`dispatch()` against the original `executedQuery`) and every
`reproducedRowCount` matched `originalRowCount`. Spot-checked
`multi-sum-all-three` directly: 3 citations, all `reproduced: true`,
`originalRowCount === reproducedRowCount === 1` for each source.

## 3. Conflict behavior

The codebase has **two structurally distinct "conflict" mechanisms** — this
matters for what the golden fixture's two seeded-conflict cases actually
exercise:

1. **Reduce-level tie** (`verifyAndReduceNode.ts` → `conflictNode.ts`,
   deterministic code, no LLM call): when a max/min multi-source reduction
   has more than one winner, the graph routes straight to `conflictNode` →
   `END`. `buildAnswerMulti`/`faithfulnessMulti` are never reached — there is
   nothing to regenerate, a genuine tie can't be resolved by asking the model
   again.
2. **Faithfulness-retry** (`applyFaithfulnessVerdict()` in
   `apps/worker/src/lib/llm/prompts/faithfulness.ts`, shared by both single-
   and multi-source graphs): if the LLM faithfulness grader disagrees with a
   generated answer, the answer is regenerated exactly once
   (`faithfulnessOutcome: "conflict-retry"`), then shipped with
   `faithful: false` if it disagrees again (`"conflict-final"`).

The golden fixture's `multi-conflict-max-two` and `multi-conflict-min-three`
exercise mechanism **(1)**, not (2). Confirmed live via Langfuse span trees
for both traces (`73c9d2b7-...`, `634b6b5a-...`):
`verifyAndReduce → conflict → END`, zero `buildAnswerMulti`/
`faithfulnessMulti` spans, zero LLM calls. This is correct, expected
behavior for a real tie — not a gap — but it means **mechanism (2), the
literal "regeneration" path, was not observed live in this phase.** It's
structurally proven only via mocked unit tests (`graph.test.ts`,
`multiSource/graph.test.ts`). Carried to Phase 5 as an open item below.

## 4. Latency (single-source, real `/api/backend` proxy path)

### 4.1 Remediation applied

Two bugs were identified and fixed (see git history for the full diffs):

1. **Event replay.** `apps/worker/src/lib/chat/publish.ts` now stamps every
   `ChatStreamEvent` with a per-job monotonic `seq` (Redis `INCR`) and
   `ts` (worker-side publish clock), wraps it in a `ChatStreamEnvelope
   {seq, ts, event}` (`packages/schemas/src/chat.ts`), and durably
   `RPUSH`es it to `chat:events:log:{orgId}:{jobId}` (capped via `LTRIM`,
   `EXPIRE`d after `CHAT_EVENTS_LOG_TTL_MS`, default 600s) *before*
   `PUBLISH`ing it live — write-before-notify, so a live subscriber is
   always guaranteed the matching log entry already exists.
   `apps/api/src/lib/sse.ts`'s new generic `subscribeWithReplay()` util
   subscribes live first (buffering), `LRANGE`s the full persisted log and
   emits it in order, drains the live buffer deduped by `seq`, then goes
   fully live — a client connecting at any point, including after the job
   finished (within the TTL), receives the complete ordered sequence
   exactly once. `GET /chat/stream` also now accepts `?after=<seq>` for
   reconnect-resume, wired into the chat UI's manual Retry
   (`apps/web/src/components/app/ChatClient.tsx`'s `lastSeqRef`). The util
   is deliberately chat-agnostic (channel/listKey are parameters) for
   Phase 5's Logs feature to reuse.
2. **Header-flush delay.** `runSse` (`apps/api/src/lib/sse.ts`) now calls
   `res.flushHeaders()` and writes `": connected\n\n"` immediately after
   `res.writeHead()`, instead of leaving Node to hold the response headers
   unsent until the first real event write. (Compression was confirmed to
   already be off for this route — no compression middleware exists
   anywhere in `apps/api`.)

Regression coverage: `apps/api/src/lib/sse.replay.test.ts` (new vitest
suite, 4/4 passing — late-connect full replay, live events after replay
settle into live mode, `afterSeq` resume dedup, abort-without-terminal
resolves cleanly) plus the existing `apps/worker` vitest suite (58/58
passing, unaffected — `publishChatEvent`'s public signature didn't change)
and `chat-smoke.ts` (38/38 assertions passing against real sandbox DBs +
real model, `collectEvents` updated to unwrap the new envelope).

### 4.2 Re-measurement (honest hop breakdown)

Measured via `apps/web/latency_hops.mjs` (10 sequential runs, logged-in
Playwright session, real `apps/api` + `apps/worker` + Redis path — BullMQ's
own `timestamp`/`processedOn` job-hash fields and each SSE envelope's
worker-stamped `ts` are used as real server-side timestamps for the
worker-side hops, not client-side inference):

```
POST send -> BullMQ enqueue             p50=130ms   p95=155ms
Enqueue -> worker picks up job          p50=1ms     p95=3ms
Pickup -> first stage event             p50=4ms     p95=15ms
First stage -> first token (worker)     p50=8482ms  p95=12498ms
Worker publish -> client receipt        p50=3ms     p95=33ms
-----------------------------------------------------------------
TOTAL: POST -> first stage event (client)  p50=219ms   p95=259ms
TOTAL: POST -> first token (client)        p50=8603ms  p95=12642ms
```

A representative single-run trace (client-perceived ms since `POST` sent):

```
rewriting:              194ms   <- client now sees this immediately
resolving:               194ms
introspecting:            194ms
generating_query:         194ms
executing:               4299ms   <- ~4.1s LLM call to generate the SQL query
generating_answer:       4377ms   <- query executed in ~80ms
checking_faithfulness:   8011ms   <- ~3.6s LLM call to generate the answer
first token (client):    7999ms   <- arrives essentially AT the end of
                                      generating_answer, not progressively
                                      through it
```

**Exit bar (p50 time-to-first-token < 3s): STILL FAIL.** Per Task 4, this
report stops here without further optimization.

### 4.3 Which bug caused how much of the original 7702ms

**Neither bug meaningfully caused the original first-token number.** Their
damage was entirely to *perceived responsiveness*, not to first-token
latency:

- **Time-to-first-stage-event** (how long a user stares at nothing before
  seeing *any* progress feedback) dropped from **p50=4268ms to p50=219ms —
  a ~20x fix.** This is the replay bug's real, large, now-resolved impact:
  previously the subscribe-race silently dropped `rewriting`/`resolving`/
  `introspecting`/`generating_query` (which all fire within ~200ms of each
  other, before the ~4s query-generation LLM call), so the client's first
  visible event was `"executing"` (the 4th stage) at ~4.3s. Post-fix, the
  client sees `rewriting` at ~200ms, same as the true worker-side timing.
- **Time-to-first-token barely moved** (old p50=7702ms vs. new p50≈7999–
  8603ms across two 10-run batches — within normal LLM-latency run-to-run
  variance, not a regression). The events the old subscribe race dropped
  were exactly the cheap, fast, front-loaded stage events; by the time the
  two expensive LLM calls (`generating_query`'s ~4s query-generation call,
  `generating_answer`'s ~3.6–9s answer-generation call) produced their
  events, the late-subscribing client was already connected and caught
  everything downstream intact. So the subscribe-race bug cost users ~4s
  of dead-air progress feedback, not ~4s of actual first-token delay.

**The true bottleneck is backend LLM latency**, split roughly evenly across
two sequential model calls that gate first-token: query generation
(`generating_query` → `executing`, ~4s) and answer generation
(`generating_answer` → first token, ~3.6–9s, the dominant source of the
high p95). `apps/worker/src/lib/chat/nodes/buildAnswer.ts` does call the
model with `stream: true` and publish a `token` event per delta — it is not
naively buffering a completed answer in code — but the observed first-token
timestamp lands essentially at the same instant as `checking_faithfulness`
(the *next* node, which only starts once `buildAnswer` fully resolves),
meaning the model's own output is not arriving in a way that produces an
early meaningful delta. Per Task 4, the choice between (a) investigating
why streaming isn't yielding early content, (b) parallelizing/skipping the
query-generation LLM call for simple queries, or (c) revising the exit bar
with this evidence, is left to the next decision rather than acted on here.

### 4.4 Task 4: query-gen model tier, answer-gen first-delta, cheap trims — no net win, bar still fails

Investigated all three levers named in Task 4's decision spec. Each is
written up honestly below, including the two that found nothing worth
shipping — no code changed the shipped pipeline's runtime behavior. All
regression suites are green on the final (unchanged-from-§4.2) config:
`pnpm --filter @nia/worker test` 58/58, `pnpm --filter @nia/api test` 4/4,
`chat-smoke.ts` 38/38 assertions, `eval:golden` 20/20 (acceptance gate
PASS, run id `fe52a2b2-b8f1-4b65-bcc4-f5e0b6ff33b0`).

**Fix 1 — query-gen model tier: reverted, no viable fast tier found.**
Built the infrastructure for it (`LlmCallContext.model`/`QUERYGEN_MODEL`/
`ANSWER_MODEL` in `gatewayClient.ts`/`env.ts`, still present, unused) and
quality-gate-tested two Gemini flash tiers for `generateQuery.ts` against
the golden set:
- `google/gemini-3.5-flash`: quality-clean across every run (only failures
  were the pre-existing `multi-conflict-*` flakiness in `planReduction.ts`,
  which was never touched). But it is **slower than the default model**:
  isolated query-gen hop (`generating_query` status ts → next stage ts, 10
  runs via `apps/web/latency_querygen.mjs`) came back p50=6350ms — worse
  than the default model's own p50=5616ms measured the same way. Root
  cause, confirmed via direct gateway probing (`provider_metadata.gateway.
  routing` debug field): this account's Google BYOK credential is invalid
  at the platform level (`"API key not valid"`), so every Gemini call
  silently falls back to the gateway's Vertex path, which forces a
  mandatory ~100–150 `thoughtsTokenCount` reasoning overhead for
  `gemini-3.5-flash` that no tested `reasoning` param
  (`enabled:false`/`max_tokens:1`/`effort:minimal|low`) could suppress.
  Tested with a newly-provided `NIA_GATEWAY_API_KEY` too — BYOK routing is
  an account-level config, not tied to the client key, so this didn't
  change the outcome.
- `google/gemini-2.5-flash` + explicit `reasoning:{enabled:false}` (2.5's
  reasoning IS controllable, unlike 3.5's): 3 golden-eval runs came back
  18/20, 19/20, 18/20, with a **new failure not seen on any other
  config** — `multi-count-all-three` (a multi-source COUNT reduction,
  exactly the case class Task 4's spec named as must-hold) failed once.
  This is a real regression, not baseline flakiness, so per the spec's own
  instruction ("if any regression, report which questions and revert that
  call site only") this tier was rejected.

Net: neither tier cleared both bars (quality + speed) at once, so
`generateQuery.ts` and `planReduction.ts` both stay on the default model —
functionally unchanged from §4.2. `QUERYGEN_MODEL` is left unset/unused in
every real env file, documented in `env.ts`/`.env.example` as unused
pending the gateway's BYOK routing being fixed platform-side.

**Fix 2 — answer-gen first-delta latency: no fixable cause found in the
three investigated areas.** Investigated in the spec's stated order:
1. *Prompt shape* (`answerGen.ts`): already a short system+user pair, no
   prose-before-structure. Confirmed irrelevant by probing the gateway
   directly with an even shorter prompt ("Say hi.") — latency was
   unchanged.
2. *SDK/streaming batching*: `gatewayClient.ts`'s `streamComplete()` calls
   `onToken` synchronously for every `chunk.choices[0].delta.content` the
   instant it arrives off the SDK's async iterator — no app-side buffering
   exists to remove.
3. *Thinking/reasoning config*: `usage.completion_tokens_details.
   reasoning_tokens` is `0` for the default model (`anthropic/
   claude-sonnet-4-6`) both with and without an explicit
   `reasoning:{enabled:false}`, so there is no reasoning budget to disable
   for this call site.

Direct gateway probing (bypassing the app entirely, 5 back-to-back
streamed calls on a warm connection) showed a consistent 3.0–4.0s
time-to-first-delta floor for `claude-sonnet-4-6`, reproduced with
`openai/gpt-5-mini` too (~4.0–4.5s) — i.e. this looks like inherent
provider/gateway round-trip + inference-start latency, not something in
our prompt, SDK usage, or reasoning config. The real-pipeline measurement
(`apps/web/latency_answergen.mjs`, isolating `generating_answer` status ts
→ first `token` event ts, 10 runs) came back p50=3417ms/p95=5113ms —
matching the raw gateway floor almost exactly, confirming nothing in our
own pipeline stages adds overhead on top of it. No code change made; there
is no fix available within this investigation's scope.

**Fix 3 — cheap pipeline trims: both checked areas were already correct,
nothing to trim.**
- `rewrite.ts` is already a pure pass-through (`return { standaloneMessage:
  state.rawMessage }`) — no LLM call exists on this path to fast-path.
- `introspection.ts`'s schema cache is already keyed on `connectionId:
  credVersion` with a TTL (`SCHEMA_CACHE_TTL_MS`, default 5min) and
  failure-driven invalidation — it does not re-fetch per request.

No code changes made for Fix 3.

**Re-baseline (10 runs, `apps/web/latency_hops.mjs`, same method as §4.2,
final/unchanged config):**

```
POST send -> BullMQ enqueue             p50=124ms   p95=180ms
Enqueue -> worker picks up job          p50=1ms     p95=3ms
Pickup -> first stage event             p50=4ms     p95=14ms
First stage -> first token (worker)     p50=8295ms  p95=12173ms
Worker publish -> client receipt        p50=3ms     p95=5ms
-----------------------------------------------------------------
TOTAL: POST -> first stage event (client)  p50=216ms   p95=276ms
TOTAL: POST -> first token (client)        p50=8431ms  p95=12276ms
```

Within run-to-run variance of §4.2's p50=8603ms/p95=12642ms — **no
measurable change**, consistent with all three fixes landing as
no-ops on the shipped pipeline.

**Exit bar (p50 time-to-first-token < 3s): STILL FAIL, unchanged.**

**Per-fix contribution: zero.** None of Fix 1/2/3 changed runtime
behavior. The ~8s bottleneck is two sequential LLM calls (query-gen ~4-6s,
answer-gen first-delta ~3-5s) against this gateway account's current
provider routing, and neither call's latency floor was reducible via any
of the six levers investigated across Fix 1 and Fix 2 (model tier,
reasoning config, prompt shape, SDK batching — twice each, once per call
site).

**Bar recommendation (evidence for the decision, not a decision made
here — per Task 4, this stops after this update):** the 3s bar assumed a
fixable inefficiency existed in prompt shape, streaming, or reasoning
config. This investigation found none — the floor is the gateway/
provider's own per-call round-trip and inference-start time, reproduced
identically on a trivial "Say hi." prompt and across two different model
families (Claude, GPT-5-mini). Closing the gap to <3s would need one of:
(a) fixing the account's Google BYOK credential so a genuinely fast,
reasoning-controllable Gemini tier becomes viable for query-gen (the one
lever that showed real signal — 2.5-flash's failure was a golden-set
regression, not a hard technical wall, and could be re-attempted once
BYOK works, possibly combined with a prompt tweak to close the COUNT-case
gap); (b) parallelizing or eliminating one of the two sequential LLM calls
architecturally (not attempted — out of scope for "cheap trims, no
redesign"); or (c) revising the bar. No further optimization attempted
here.

## 5. Open risks carried to Phase 5

1. ~~**SSE subscribe race drops early pipeline events.**~~ **FIXED** (see
   §4.1) — `subscribeWithReplay()` now durably logs every event
   (write-before-notify) and replays the full ordered log to any client
   regardless of when it connects, including after the job finished.
   Verified live: time-to-first-stage-event dropped ~20x (p50 4268ms →
   219ms). Regression-covered by `apps/api/src/lib/sse.replay.test.ts`.
2. ~~**`runSse` never flushes headers early.**~~ **FIXED** (see §4.1) —
   `res.flushHeaders()` + an immediate `": connected\n\n"` write now happen
   right after `res.writeHead()`.
3. **p50 time-to-first-token badly fails the <3s exit bar, and it is NOT a
   transport bug, a prompt-shape bug, an SDK-batching bug, a reasoning-
   config issue, or a stale-cache/redundant-LLM-call issue** — §4.4 (Task
   4) exhausted all of those as candidate causes (quality-gate-tested two
   Gemini tiers for query-gen, probed prompt shape/streaming/reasoning for
   answer-gen, confirmed rewrite/introspection are already optimal) and
   found none reduced the ~8.3–8.6s p50, which held stable across every
   remeasurement. Root cause is now understood: two sequential LLM calls
   (query-gen ~4-6s, answer-gen first-delta ~3-5s) each sitting at this
   gateway account's provider round-trip/inference-start floor — reproduced
   even on a trivial one-word prompt and across two different model
   families (Claude, GPT-5-mini), so it isn't specific to this pipeline's
   prompts or code. One real, not-yet-actionable lever was found: the
   account's Google BYOK credential is invalid, forcing all Gemini calls
   through a slower Vertex fallback with mandatory reasoning overhead —
   fixing that platform-side would make a fast, reasoning-controllable
   Gemini tier for query-gen worth a second attempt (gemini-2.5-flash was
   quality-clean except for one COUNT-case regression, which is closer to
   a prompt-tuning problem than a hard wall). Otherwise, Phase 5 needs to
   decide between: (a) getting the account's Google BYOK credential fixed
   and re-attempting a fast query-gen tier, (b) parallelizing or
   eliminating one of the two sequential LLM calls architecturally, or (c)
   revising the latency exit bar.
4. **Faithfulness-retry regeneration path (`conflict-retry`/
   `conflict-final`) has never been observed live via Langfuse/golden-eval**
   — only proven via mocked unit tests. Both golden seeded-conflict cases
   exercise the separate, zero-LLM reduce-tie mechanism instead. Consider
   adding a golden case that forces a faithfulness disagreement (e.g. via a
   deliberately misleading prompt/fixture) so this path gets live
   trace/eval coverage too.
