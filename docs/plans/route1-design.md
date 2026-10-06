# Route 1 design — reading a "Local database (via agent)" source through Nia Core

Scope: a workflow whose source is a `sqlserver-agent` connection
(`packages/schemas/src/connectors/sqlserver_agent.ts:24-48`, manifest name "Local
database (via agent)") and whose destination is any existing destination
(mysql/postgres/mongo). This document only extends
`docs/plans/agent-canvas-integration.md`'s B.9 ("Route 1 — through Nia Core") with
exact file:line detail, the structured payload shape, the bridge `/execute`
mechanics, agent-side keyset paging for composite/no-PK tables, and a throughput
estimate with a path to ≥1,000 rows/sec. It does not restate B.1-B.8/B.10-B.15.

---

## 1. Where the worker builds read queries, and what changes

All reads funnel through one generic path: `dispatch()`
(`apps/worker/src/lib/dispatch.ts:37`) → `resolveConnection()`
(`apps/worker/src/lib/resolveConnection.ts:42`) → `validateBeforeDispatch()`
(`packages/guardrails/src/registry.ts:30`, mints a `ValidatedQuery`) →
`sendToConnector()` (`apps/worker/src/lib/connectorClient.ts:81`), one HTTP
`POST {manifest.service.host}:{port}/execute`. `manifest.service` for
`sqlserver-agent` is `{host:"agent-bridge",port:4041}`
(`sqlserver_agent.ts:47`) — the internal listener, same isolation as
`connector-mysql`/`-mongodb`/`-supabase`.

Three call sites build the `QueryPayload` that eventually reaches that `/execute`
call, plus one that builds a COUNT-style pre-check that has no structured
equivalent:

| File:lines | Function | Builds | Change needed | Size |
|---|---|---|---|---|
| `apps/worker/src/lib/etl/queryBuilder.ts:56-110` | `buildEtlReadQuery` | Per-chunk SQL/pipeline text, keyed on `dialect` (`"mysql"\|"postgres"\|"mongo"`) | New `dialect === "structured"` branch returning `{kind:"structured", table, columns, filter, cursor, limit}` instead of SQL text | Medium (~40-60 lines, no change to the existing branches) |
| `apps/worker/src/lib/etl/queryBuilder.ts:134-161` | `buildFailurePreCheckQuery` | A `COUNT(*)` query with pushed WHERE/GROUP/HAVING | No structured equivalent exists (no aggregate concept in the structured payload, §2) — skip the FailurePreCheck step for this dialect with a clear message instead of building a query | Small (~10 lines, early return) |
| `apps/worker/src/lib/preview/runPreview.ts:129-158` | `buildPreviewQuery` | One-shot `SELECT ... AS alias` / `$project` for mapping field-aliasing | New structured branch with **no** `AS` aliasing (structured payload has no projection-rename capability, §2) — column rename must move to a post-fetch, worker-side step | Medium (~30-50 lines + a rename step after the `dispatch()` call at `runPreview.ts:281`) |
| `apps/worker/src/lib/profile/sampleEntity.ts:36-66` (`buildSqlPage`/`buildMongoPage`) and `:130-152` (`fetchUnkeyedPage`) | keyset head/tail paging + no-key fallback | `SELECT ... WHERE key >/< cursor ORDER BY key LIMIT` / Mongo pipeline equivalents | New `buildStructuredPage` (same head/tail two-pass shape) + structured branch in the no-key fallback | Medium (~50 lines) |
| `apps/worker/src/lib/connectorClient.ts:35-42` (`DEFAULT_TIMEOUT_MS = 15000`) | `sendToConnector` | Fixed 15s timeout on every `/execute` call | A longer, manifest-specific timeout override for `sqlserver-agent` (§3) | Small (~15 lines) |
| `apps/worker/src/lib/dispatch.ts`, `resolveConnection.ts` | generic dispatch | — | **None** — both are already fully generic over `manifest.service.{host,port}` (confirmed: no per-connector-kind branch in either file) | None |
| `apps/worker/src/lib/etl/runEtl.ts:768-771` (dialect-null hard fail) and `:967-971` (single-column-PK hard fail) | run-start preconditions | Refuses to run if `manifestDialect()` returns `null`, or if `entity.primaryKey` is null for a non-mongo, non-aggregate source | **None**, provided `manifestDialect()` (next row) returns a real value and the agent correctly reports `primaryKey` (§4) — both existing gates then apply unchanged, with no special-casing for agents | None (conditional on §4) |
| `packages/schemas/src/pushdown.ts:65-71` (`manifestDialect`) | dialect lookup | Maps `connector_id` → `"mysql"\|"postgres"\|"mongo"\|null`; today `sqlserver-agent` → `null` | Add `if (manifestId === "sqlserver-agent") return "structured";` and extend the `SourceDialect` type | Small (~10 lines, not in apps/worker) |
| `packages/schemas/src/contract.ts:130-145` (`QueryPayload` union) | wire contract | `SqlQueryPayload \| MongoQueryPayload` | Add `StructuredQueryPayload` as a third discriminated-union member (§2) | Small (~15 lines, not in apps/worker) |
| `packages/guardrails/src/registry.ts:14-19` (`GUARDRAIL_REGISTRY`) + new `packages/guardrails/src/structured.ts` | validator dispatch | Only `mysql`/`mongodb`/`supabase`/`postgres` registered today | New `validateStructuredQuery` + one registry entry for `sqlserver-agent` | Medium (~80-120 lines, new file; not in apps/worker) |

**Net apps/worker footprint: 5 files touched** (`queryBuilder.ts`, `runPreview.ts`,
`sampleEntity.ts`, `connectorClient.ts`, and — only if the agent's `primaryKey`
reporting isn't fixed per §4 — `runEtl.ts`), none of them large; `dispatch.ts`/
`resolveConnection.ts` need nothing, matching B.9's own claim.

---

## 2. The structured read payload

```ts
// packages/schemas/src/contract.ts, joining the existing QueryPayload union
export const StructuredQueryPayload = z.object({
  kind: z.literal("structured"),
  table: z.string(),                     // catalog-resolved entity name, e.g. "dbo.orders" — never parsed, exact-match only
  columns: z.array(z.string()),          // plain column names; empty = "all columns" (mirrors packages/extract/src/types.ts:65-70's ExtractRequest convention)
  filter: z.array(StructuredFilterCondition), // AND-joined
  cursor: z.object({ column: z.string(), value: z.union([z.string(), z.number()]).nullable() }).nullable(),
  limit: z.number().int().positive(),
});
export const QueryPayload = z.discriminatedUnion("kind", [SqlQueryPayload, MongoQueryPayload, StructuredQueryPayload]);
```

It joins the existing `QueryPayload` union at `contract.ts:142` as a third
discriminant, so `ExecuteRequest.query` (`contract.ts:150`), `ValidatedQuery.query`
(`packages/guardrails/src/validated.ts:22`), and `sendToConnector`'s body
(`connectorClient.ts:101`) need zero shape changes — all three are already typed
generically over `QueryPayload`.

**Filter operators** — reuse, don't reinvent: `packages/extract/src/types.ts:41-54`
already defines a closed, vetted 11-operator set (`eq,neq,gt,gte,lt,lte,in,between,
startsWith,isNull,isNotNull`) with a `MAX_IN_VALUES = 1000` cap
(`types.ts:72`) and a dialect-agnostic compiler (`compileWhereClause`,
`packages/extract/src/filterBuilder.ts:68-109`) that the agent's own
`buildSelectSql.ts:78` already calls. `StructuredFilterCondition` should be
exactly `packages/extract/src/types.ts:59-63`'s `FilterCondition` type, imported
by `packages/schemas` rather than redefined, so there is one filter-shape
contract, not two.

**Validation rules** (`packages/guardrails/src/structured.ts`, new):
- `table`/every `columns[]` entry/every `filter[].column` must match a plain
  identifier regex. `contract.ts:174-177` already defines `SqlIdentifier =
  /^[A-Za-z_][A-Za-z0-9_]*$/` for the write path — reuse it for columns, but
  `table` needs a second regex allowing exactly one `.` (schema-qualified names
  like `dbo.orders`), since `SqlIdentifier` itself rejects dots.
- `filter[].operator` must be in `FILTER_OPERATORS` (`types.ts:41-53`); `"in"`/
  `"between"` value counts bounded by `MAX_IN_VALUES` (`types.ts:72`) — both
  checks already implemented by `validateCondition`
  (`packages/extract/src/filterBuilder.ts:38-48`), reusable as-is.
- `limit` capped at the same row-cap convention the SQL/Mongo validators already
  enforce (`packages/guardrails/src/sql/validator.ts:49`, `maxRows: 1000`) —
  clamp down, never reject.
- `cursor.column`, when present, must equal the entity's reported `primaryKey`
  (§4) — rejecting an arbitrary cursor column is what guarantees the
  `WHERE col > value` the agent appends actually produces a monotonically
  advancing, non-skipping, non-repeating page sequence.

---

## 3. The bridge's `/execute` for this type

Today `/execute` (`services/agent-bridge/src/internalApp.ts:238-245`) is a stub
that always returns HTTP 501 and never creates a task. The design replaces it
with the same pattern `/test` (`internalApp.ts:194-216`) and `/introspect`
(`internalApp.ts:221-233`) already use:

1. Parse `ExecuteRequest` (`contract.ts:147-154`); verify the HMAC `ReadContext`
   (same `signReadContext`/`verifyReadContext` scheme the three existing
   connector services use, per `agent-canvas-integration.md:376-378`).
2. Online check against `ONLINE_THRESHOLD_MS = 90_000`
   (`internalApp.ts:57`) — same early-refusal-without-a-task pattern as
   `/introspect`.
3. Insert one `agent_tasks` row, `kind: "read_batch"` (one of the task kinds
   already named in B.3/`app.ts:328`), `payload = {table, columns, filter,
   cursor, limit}` — the structured fields verbatim. **No credential, no
   `manifestId`** travels in the payload; the agent already knows which local
   DB to hit via its own `agentConnectionId` mapping (`sqlserver_agent.ts:35-38`'s
   `configSchema`).
4. `taskBus.wakeAgent(agentId)` (`services/agent-bridge/src/taskBus.ts`) —
   nudges an already-held check-in; if the agent is between check-ins, the next
   one picks the task up naturally (checkInLoop fires immediately after each
   check-in returns).
5. `taskBus.awaitTaskResult(taskId, timeoutMs)`, with a **new** `TASK_TIMEOUT_MS
   .read_batch` entry added to the existing map at `internalApp.ts:59-67`
   (today only `test_connection: 8_000` / `list_tables: 45_000`). Propose
   **40,000 ms** — long enough to cover one full check-in hold
   (`CHECK_IN_HOLD_MS = 25_000`, `services/agent-bridge/src/app.ts:23`) plus
   query + serialize time, short enough to fail fast if the agent is truly gone.
6. On success, map the agent's `result` (an array of rows + column list) into
   `ExecuteResponse` (= `TabularResult`, `contract.ts:155`).
7. On timeout, the existing best-effort "mark `agent_tasks` row failed"
   behavior (`internalApp.ts:174-180`) applies unchanged.

**Task delivery and claiming** mirror `list_tables` exactly: `AgentTask`'s
discriminated union and `TaskRunner`'s `switch` (`apps/agent/src/link/
taskRunner.ts:202-213`) get a new `"read_batch"` case, with its own entry in
the agent-side `TASK_TIMEOUT_MS` map (`taskRunner.ts:20-27`), matching the
bridge's 40,000 ms.

**Batch upload — reusing `/task-results`, not a new endpoint.** The agent posts
its row batch back via the existing `POST /agent-api/task-results`
(`services/agent-bridge/src/app.ts:444-468`), the same plain-JSON-body route
`list_tables` already uses to return a (potentially large) catalog
(`taskRunner.ts:101-103`). This avoids inventing a dedicated upload route;
the cost is that Fastify's default body-size limit (no `bodyLimit` override
exists today on either listener — confirmed) must be raised on the **public**
listener specifically to fit the cap below. Size cap: **5 MB uncompressed
JSON per batch** (matching B.9's own number, chosen to ride inside one
long-poll response cycle rather than needing a dedicated bulk-upload path).
No compression — `/task-results` is a plain JSON POST, unlike the agent's
Planometry delivery path (`apps/agent/src/planometry/client.ts:82-83`, gzip)
which is a separate, unrelated transport. The agent self-enforces the cap
(`JSON.stringify(result).length` check before posting) and fails the task
locally with `errorClass: "batch_too_large"` if exceeded, rather than letting
the bridge reject an oversized POST after the fact.

**Where it waits, and for how long**: identical state machine to every other
task kind — `pending` → `delivered` (claimed by a check-in) → `done`/`failed`
(via `/task-results`), same hourly cleanup sweep of `done`/`failed` rows older
than 7 days (`services/agent-bridge/src/index.ts:22-29`). Propose
`expires_at = now() + 2× TASK_TIMEOUT_MS.read_batch` (80s) at task-creation
time, matching the pattern other task kinds already use.

**Cancel**: there is no dedicated cancel message in the protocol today for
any task kind (confirmed — only timeout-based failure exists). Route 1 reuses
the same cooperative mechanism `runEtl.ts` already has for every connector:
`getRunCheckpoint()` polls `workflow_runs.status` between chunks
(`runEtl.ts:653`) — once a run is cancelling, the worker simply stops issuing
new `read_batch` `/execute` calls; an already-in-flight one is left to finish
or time out on its own, exactly as a cancelled run today leaves an in-flight
`connector-mysql` `/execute` call to finish. No new agent-side cancel signal
for v1 (open question §7.6).

**Timeouts, summarized**: bridge `TASK_TIMEOUT_MS.read_batch = 40,000 ms`;
agent-side matching `40,000 ms`; `connectorClient.ts`'s new per-manifest
override for `sqlserver-agent` ≈ `45,000 ms` (bridge timeout + 5s slack), so
the worker's own HTTP client never gives up before the bridge would.

---

## 4. The agent's side — executing a read task with existing extract code

**Normal case (single-column PK).** The new `"read_batch"` case in
`TaskRunner` (`taskRunner.ts:202-213`) reuses the same `connect()` +
`introspectCatalog()` helpers `test_connection`/`list_tables` already import
from `@nia/extract/mssql`, resolves the table/columns via `catalog.ts`'s
`resolveTable`/`resolveColumn` (the same catalog-lookup-only safety model
`streamExtract.ts:84`'s `validateExtractRequest` already uses — identifiers
are never parsed from caller input, only matched against the server-generated
catalog), and builds a request:
`{table, columns, filter: [...incomingFilter, {column: cursorColumn, operator:"gt", value: cursor.value}]}`
when a cursor is present.

**A genuine gap: no `ORDER BY`.** `buildSelectSql`
(`packages/extract/src/mssql/buildSelectSql.ts:59-88`) builds `SELECT TOP(n)
cols FROM table WHERE ...` with **no `ORDER BY` clause at all** (confirmed —
`rawSql` at line 85 has none). Without one, SQL Server's `TOP(N)` has no
ordering guarantee, so successive `WHERE pk > cursor` calls could skip or
repeat rows under concurrent writes or plan changes. This needs a small,
additive extension — an `orderBy: string[]` parameter appending `ORDER BY
<cols>` after the `WHERE` clause (~5 lines) — used only by the new read-batch
path; `streamExtract`'s existing full-dump callers pass none and are
unaffected. A new one-shot `extractOneBatch()` helper (built on the extended
`buildSelectSql` + a plain `pool.request().query()`, not `streamExtract`'s
`stream = true` + backpressure machinery, since a bounded `TOP(1000)` read
needs none of that) is the actual call the `read_batch` task handler makes.

**Composite primary key.** SQL Server reports a composite PK as multiple rows
from `sys.index_columns` for one `is_primary_key` index. Mirroring the
existing convention in `services/connector-mysql/src/index.ts:157-165` and
`services/connector-supabase/src/index.ts:238-246` ("composite PK → report
`primaryKey: null`, treated identically to no PK found"), a new PK-detection
query needs adding to `packages/extract/src/mssql/introspect.ts` (which today
has **no PK detection at all** — confirmed: `CatalogTable`,
`packages/extract/src/types.ts:27-33`, has no `primaryKey` field, and
`taskRunner.ts:116` hardcodes `primaryKey: null` unconditionally for every
`list_tables` response). The new query groups `sys.indexes`/`sys.index_columns`
by table and only sets a `primaryKey` when the column count is exactly 1. A
composite-PK table then reports `primaryKey: null`, which `runEtl.ts:967-971`'s
**existing** precondition already hard-fails on once `manifestDialect()`
returns a real value for this connector (§1) — no new `runEtl.ts` code, no
agent-specific special case. This is the same v1 limitation every other
connector already has, not something invented for agents.

**View with no primary key.** Same answer: zero PK columns → `primaryKey:
null` → same existing gate, same rejection. The one rough edge:
`runEtl.ts:969`'s message ("Add a primary key... to this table") is wrong for
a view. `packages/extract`'s `CatalogTable.kind` (`types.ts:30`) already
distinguishes `table`/`view`, but `IntrospectResponse.entities`
(`contract.ts:73-121`) has no `kind` field today for any connector to pass it
through. Proposed: add an optional `kind: "table"|"view"` to
`IntrospectResponse`'s entity shape so `runEtl.ts` can branch the wording
("...views can't be used as an ETL source for this connector") — small,
additive, and only the agent would populate it initially.

**No fallback is proposed** (no `ROW_NUMBER()`/offset paging) — consistent
with every other connector's existing "composite/no PK → hard fail, ask the
user to add one" policy, and with B.9's "no free-form SQL on the agent"
constraint. A window-function workaround is technically buildable within
`buildSelectSql`'s existing parameterized-template model without introducing
free-form SQL, but it adds real complexity for a case the rest of the system
already treats as unsupported — revisit only if real pilot tables hit this
wall (§7).

---

## 5. Speed

Per-chunk cost, in order: BullMQ dequeue + `resolveConnection()`
(tens of ms) → guardrail validation (≈1ms, in-memory) → worker→bridge
`POST /execute` (5-20ms, same docker network as other connectors) → bridge
inserts `agent_tasks` row + `wakeAgent()` (5-15ms) → **wait for the agent's
check-in to claim the task** → SQL Server query (tens of ms for `TOP(1000)
WHERE pk > cursor ORDER BY pk` on an indexed PK) → agent serializes rows and
`POST /agent-api/task-results` (tens-to-low-hundreds of ms, public internet,
agent → platform) → bridge resolves the waiting promise → worker does its
normal residual-transform/write-chunk work (unchanged cost vs. any other
connector).

**The slowest step is the check-in round trip itself, not the SQL Server
query or the worker's own processing.** Because the agent's check-in loop
re-fires immediately after each check-in returns (`checkInLoop.ts`), a newly
created task is typically claimed within a few hundred ms to low seconds —
not the full 25s hold — provided the loop is healthy and not itself blocked
on a prior task. Realistic per-chunk round trip: **≈1-3 seconds**, worse (up
to the full `CHECK_IN_HOLD_MS = 25,000`) if the task narrowly misses an
already-in-flight check-in.

At today's `MAX_CHUNK_ROWS = 1000` (`queryBuilder.ts:50`) and ~1-3s/chunk:
**≈300-1,000 rows/sec best case, realistically 100-500 rows/sec** once
check-in contention is accounted for — consistent with (slightly more
optimistic than) the existing plan's own estimate at
`agent-canvas-integration.md:529-536` ("tens-to-low-hundreds of rows/second").

**To reach ≥1,000 rows/sec**, the fixed ~1-3s round-trip latency has to be
amortized over more rows per trip — row count is cheap (an indexed PK scan),
the round trip is not. Two levers:

**(a) Raise the row cap for this connector type only** — a new constant
distinct from `MAX_CHUNK_ROWS`, used only in the `"structured"` branch of
`buildEtlReadQuery` and enforced by the new `structured.ts` guardrail. At
~200-400 bytes/row for a typical narrow table, the existing 5 MB batch cap
(§3) comfortably holds 12,000-25,000 rows. Raising the per-chunk limit to
~10,000-20,000 rows turns the same ~1-3s round trip into roughly
10,000-13,000 rows/sec — well over the 1,000 rows/sec bar. Cost: a bigger
in-memory row buffer on both the agent (one `TOP(N)` result set) and the
bridge (one up-to-5MB JSON parse).

**(b) Let the agent run several chunks per task** — add a `batches: number`
field to the structured payload so one `read_batch` task internally loops N
times (bumping its own cursor each iteration), returning an array of
row-batches in one task-result. This amortizes the check-in-claim latency
(the genuinely fixed cost) across N chunks of query+serialize time. Cost: a
real trade-off, not a free win — the worker's cursor checkpoint
(`runEtl.ts:1085`) would only persist once per task instead of once per
chunk, coarsening resume/cancel granularity.

**Recommendation**: (a) first — one new constant plus one guardrail limit, no
new payload shape, no checkpoint-granularity cost. Treat (b) as a follow-up
only if (a) alone doesn't clear 1,000 rows/sec once measured against a real
agent's actual check-in latency (§7.5).

---

## 6. What a user sees — preview, profiling, Copilot on a local source

- **Preview**: works once `runPreview.ts`'s structured branch (§1) exists.
  `buildPreviewQuery()` sends one `{kind:"structured", table, columns, filter,
  limit: 50}` through the same `dispatch()`/`/execute` path — no chunking
  needed, since preview's `rowCap: 50` (`runPreview.ts:281`) is already well
  under even today's 1000-row structured limit. One real behavior
  difference: column aliasing (mapping `from`→`to`) has no SQL `AS`
  equivalent in the structured payload, so it must happen worker-side, after
  the rows return — invisible to the user if implemented correctly, but a
  genuine code-path difference from the SQL-dialect preview.
- **Profiling**: works once `sampleEntity.ts`'s structured branch exists, but
  costs at least 2 extra round trips (head pass + tail pass, each up to
  `MAX_PAGES_PER_DIRECTION = 5` pages) — so profiling a local-DB source could
  take 2-10 check-in round trips (seconds to tens of seconds) versus one HTTP
  call for mysql/postgres/mongo. Functionally correct, just visibly slower;
  worth a longer loading state in the UI specifically for agent-backed
  sources.
- **Copilot**: per `agent-canvas-integration.md:155-157`, Copilot's
  `describe_source`/`get_profile`/`preview_rows` tools call exactly the
  introspection/preview/profiling paths above — so Copilot works
  automatically once those do, with no Copilot-specific change. There is no
  "run SQL" tool today, so there's no free-form-query path that could ever
  send raw SQL to an agent-backed source.

---

## 7. Open questions

1. Reusing `/task-results` for batch upload (§3) avoids a new endpoint but
   requires raising the public listener's Fastify body-size limit to fit 5MB
   — acceptable, or build the dedicated Redis-staged upload route B.9's
   earlier draft sketched instead?
2. Lever (a) in §5 (raising the structured-path row cap to ~10-20k)
   increases per-request memory on a possibly modest on-prem agent machine —
   acceptable, or should (b) (multi-batch-per-task) be preferred despite its
   checkpoint-granularity cost?
3. Should `FailurePreCheck` (§1, `queryBuilder.ts:134-161`) simply be
   unsupported for `sqlserver-agent` sources in v1 (skip with a clear
   message), given the structured payload has no aggregate/COUNT concept?
4. Is it worth adding `IntrospectResponse.entities[].kind` (`table`|`view`,
   §4) now to word the composite/no-PK error correctly for views, or ship
   the slightly-wrong-for-views wording in v1?
5. The §5 ~1-3s/chunk estimate is theoretical — it needs measuring against
   the real Slice-4 "real check" sandbox
   (`agent-canvas-integration.md:643-646`) before committing to a specific
   raised row-cap value.
6. No preemptive cancel exists for an in-flight `read_batch` task (§3) —
   acceptable for v1 (matches every other connector's cooperative,
   between-chunks cancel), or does a slow agent-side query need its own
   cancel path sooner?
