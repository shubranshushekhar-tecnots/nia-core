# Agent–Canvas integration

Goal: let a Canvas source be a local database reached through Nia Agent (SQL Server
first, read-only, structured reads only), alongside today's connection-string sources.
Rows can go (1) through Nia Core to any existing destination with transform steps
("route 1"), or (2) directly from the agent to a destination it delivers itself —
a Planometry table or a generic HTTPS endpoint ("route 2").

Fixed decisions (given):
- Agent makes outbound HTTPS calls only; the link to Nia Core is long polling, behind
  a transport-isolated interface so it can be replaced later.
- One installer for everyone; one agent serves many connections; an org can have
  several agents.
- The SQL password is entered on the agent machine, never sent to the platform.
- A local database is a read-only source. SQL Server first.
- The agent runs structured reads only (table, columns, filter). No free-form SQL.
- Route 2: no row or key value reaches the platform. Planometry rejection details
  stay on the agent machine.
- Generic HTTPS destination is delivered by the agent; delivery *from Nia Core* is
  listed under "Later".
- The local CLI stays for troubleshooting.

---

## Part A — What exists today

### A.1 Connections — creation, storage, testing, form, registration

- **Create path**: `ConnectionForm.tsx:67` (schema-driven form, fields come from the
  connector manifest's `configSchema`, not hardcoded) → `AddConnectionDialog.tsx:24`
  (`useActionState(createConnectionAction...)`) → Server Action
  `apps/web/src/lib/connections/actions.ts:77` → Express
  `apps/api/src/routes/connections.ts:52` (`POST /connections`,
  `requireCapability("connections.create")`) → service
  `apps/api/src/services/connections.ts:181` `createConnection()`: checks
  `connector_installs`, splits fields via `splitFields(manifest.configSchema, fields)`,
  encrypts the secret half via `getSecretStore(withUser).put()`
  (`apps/api/src/lib/secretStore.ts:38`, AES-256-GCM envelope encryption in
  `packages/secrets/src/crypto.ts`), then `INSERT INTO connections` with the
  `config` (non-secret) and `vault_secret_ref` (opaque UUID into `nia_secrets`).
- **Tables**: `connector_installs` and `connections`
  (`supabase/migrations/0007_connectors.sql:26,89`) — `connections` carries
  `connector_id`, `handle`, `config jsonb`, `vault_secret_ref`, `cred_version`
  (bumped only on secret rotation; it's the connector pool's cache-key suffix),
  `last_test_*`. `write_grants` (`0007:195`, extended `0016`, `0018`, `0028`) is a
  separate table with its own `cred_version` for the write credential. Secrets live
  in `nia_secrets` (`0032_nia_secrets.sql:34`), replacing Supabase Vault; API code
  never sees plaintext, only the opaque ref.
- **Test**: `testConnectionAction` → `POST /connections/:id/test`
  (`apps/api/src/routes/connections.ts:116`) → `testConnection()`
  (`services/connections.ts:494`) → `dispatchTest()`
  (`apps/api/src/lib/connectorDispatch.ts:89`), a generic `fetch` to
  `{manifest.service.host}:{port}/test` — the connector service resolves the secret
  itself (service-role client) and never returns plaintext to the API.
- **Registration of a new connector type**: *one* place,
  `packages/schemas/src/connectors/registry.ts:14`
  (`CONNECTOR_MANIFESTS` map, comment: "zero frontend or worker changes"). Plus a
  manifest file, a URL-paste placeholder in
  `apps/web/src/lib/connections/formFields.ts:25`, and (if Postgres-family) the
  `EXTRA_SCHEMAS_CONNECTOR_IDS` set in `ConnectionForm.tsx:28`. **No switch
  statement anywhere dispatches by connector kind** — `connectorDispatch.ts` and the
  worker's `dispatch.ts` are fully generic over `manifest.service.{host,port}`.

### A.2 Canvas — blocks, panels, save/validate

- **Node types**: `GraphNodeType = z.enum(["source","transform","destination"])`
  (`packages/schemas/src/graph.ts:19`). One React Flow component for all three,
  `GraphFlowNode.tsx:74`. One config-panel component, `NodeDrawer.tsx`'s
  `SourceDestForm` (line 585), mounted once per slot (`ribbon`/`detail`),
  narrowing `manifest.operations` to read-only for source / write-only for
  destination. The source panel is just an entity (table) picker fed by
  `useConnectionEntities` (`NodeDrawer.tsx:117`, cached introspection); no column
  or filter UI at the source node today — those live in downstream transform steps.
- **Save**: debounced 800 ms autosave (`FlowCanvas.tsx:269`, `AUTOSAVE_DELAY_MS`) →
  `flowToGraph()` (`apps/web/src/lib/canvas/mapping.ts`) → `putWorkflowGraph()`
  (`apps/web/src/lib/api/graphClient.ts:57`) → `PUT /workflows/:id/graph`
  (`apps/api/src/routes/workflows.ts:52`, Zod-validates the whole `GraphDoc`
  server-side) → `workflowGraphs.ts:97`, optimistic-concurrency `UPDATE ... WHERE
  version = $3`, with a DB trigger that always bumps `version`
  (`supabase/migrations/0012_workflow_graphs.sql`).
- **Validate**: per-node `parseNodeConfig()` (`packages/schemas/src/nodeConfig.ts:604`,
  never throws, marks unknown shapes `unrecognized`) is separate from the on-demand
  **check suite** (`packages/schemas/src/checks.ts`: `checkConfig`, `checkDag`,
  `checkCredentials`, `checkMappings`, `checkGrants`), run via "Run Checks"
  (`POST /:id/checks`) or before a run, results stored append-only in
  `workflow_check_runs` (`0014_workflow_check_runs.sql`).
- **Transform steps**: `filter`, `computed_field`, `drop_fields`, `aggregate`,
  `to_json`, `flatten` — discriminated union `TransformStep`
  (`packages/schemas/src/nodeConfig.ts:555`), each with its own editor under
  `apps/web/src/components/canvas/ops/`.
- **Shared source/worker contract**: `apps/worker/src/lib/etl/runEtl.ts` imports the
  *same* `@nia/schemas` types the Canvas uses (`SourceDestConfig`, `TransformConfig`,
  `parseNodeConfig`, `findPersistedEntity` from `entityResolution.ts`) — there is one
  schema layer, not a parallel worker-side model.

### A.3 Runs — worker execution, read/write interface, batching, limits, cancel, history

- **Entry point**: BullMQ `heavy` worker, `apps/worker/src/index.ts:146`, case
  `"etl_run"` → `runEtl(payload, heavyQueue)` (`runEtl.ts:625`). Per-chunk loop:
  resolve graph → build read query → `dispatch()` → residual transforms → map
  columns → `writeChunkRows()` → `recordChunkProgress()` (persists cursor) → requeue
  next chunk or finish.
- **Read interface**: one generic path, no per-connector interface. `dispatch()`
  (`apps/worker/src/lib/dispatch.ts:37`) → `resolveConnection()` → guardrails
  `validateBeforeDispatch()` (mints a `ValidatedQuery`, private-constructor class,
  see below) → `sendToConnector()` (`connectorClient.ts:81`), one HTTP `POST
  {service}/execute`. `QueryPayload` is a union of `{kind:"sql", sql, params}` /
  `{kind:"mongo", collection, pipeline}`, built programmatically (never from raw
  user text) by `buildEtlReadQuery()` (`apps/worker/src/lib/etl/queryBuilder.ts:56`,
  keyset pagination, `MAX_CHUNK_ROWS = 1000`).
- **Write interface**: `dispatchWrite()` (`apps/worker/src/lib/writeDispatch.ts:62`)
  → `resolveWriteGrant()` → `sendWriteRequest()` → `POST {service}/write`. Staged
  vs. direct write is decided once per run (`apps/worker/src/lib/etl/stagedWrite.ts`).
- **Cancel**: `POST /:id/run/cancel` → `cancel_workflow_run` RPC flips
  `workflow_runs.status` (only while `running`). The worker polls this
  (`getRunCheckpoint()`, `runEtl.ts:653`) between every chunk — cooperative, not
  preemptive.
- **Checkpoint/resume**: cursor is persisted to Postgres (`workflow_runs.cursor_json`,
  `0017_run_checkpoints.sql`) in the same `UPDATE` as `rows_processed`; "Postgres is
  checkpoint truth, Redis/BullMQ is transport" — a resumed job always re-derives
  state from Postgres, never trusts the BullMQ payload alone.
- **History/errors**: `workflow_runs.error jsonb` (`0047_workflow_runs_error.sql`),
  written by `finishRun()`; listed via `apps/api/src/services/runs.ts:219`; live
  events over SSE (`GET /:id/run/stream`, Redis pub/sub `run:events:*`).
- **Limits**: per-request timeouts in `connectorClient.ts` (15 s read/test/write,
  30 s stage/preflight/create-entity); `MAX_CHUNK_ROWS = 1000` hard cap enforced
  independently by guardrails; plan-based `rows_per_month` check once per run
  (`runEtl.ts:234`, only hard-blocks the `free` plan today) backed by `plans`
  (`0049_plans_table.sql`) and `usage_events` (`0066_usage_events.sql`).
- **`resolveConnection`/`connectorClient`/`ValidatedQuery`**: `resolveConnection()`
  (`apps/worker/src/lib/resolveConnection.ts:42`) reads the `connections` row under
  `service_role` with an org/owner scope filter baked into the `WHERE` (that filter
  *is* the authorization check), resolves the manifest, returns a `CredentialRef`
  (never plaintext). `connectorClient.ts` has 8 thin functions, each one HTTP hop
  plus timeout plus response-shape check, nothing else. `ValidatedQuery`
  (`packages/guardrails/src/validated.ts:19`) has a **private constructor** — it can
  only be minted by `validateBeforeDispatch()`, and carries `manifestId` so
  `dispatch.ts:65` can refuse to send a query validated for one connector kind to a
  different one.

### A.4 Everything else that touches a source — and the free-form-SQL question

- **Introspection** (table/column listing): `getSchema()`
  (`apps/worker/src/lib/introspection.ts:34`, in-memory TTL cache) /
  `getConnectionSchema()` (`apps/api/src/services/connections.ts:561`, Redis-cached)
  → `POST {service}/introspect`. The connector service runs its own fixed
  metadata query; no SQL text ever leaves the worker/API for this.
- **Preview/sampling**: `buildPreviewQuery()` (`apps/worker/src/lib/preview/runPreview.ts:129`)
  and the profiler's `buildSqlPage()`/`buildMongoPage()`
  (`apps/worker/src/lib/profile/sampleEntity.ts:36`) both build a structured
  `QueryPayload` from field names already known to the system (mapping/schema),
  with an `isReadShaped()` defense-in-depth assertion before dispatch.
- **Checks**: the `credentials` check calls `/test` (a fixed `SELECT 1`-class probe);
  the `mappings` check calls `/introspect`. Neither sends SQL.
- **Copilot**: tool registry (`apps/api/src/copilot/tools/`) has `describe_source`,
  `get_profile`, `preview_rows` — all three call the same structured paths above.
  **There is no "run SQL" tool.**
- **Verdict**: no free-form/arbitrary SQL is executed against a source connection
  anywhere in the current codebase. The only entry to a connector's `/execute` is
  typed to require a `ValidatedQuery`, which cannot be constructed outside
  `packages/guardrails`; the validator rejects anything but a single `SELECT`/`WITH`
  statement and caps rows at 1000. (One documented, currently-inert gap: MySQL
  `/*! ... */` version-comment syntax is a known tokenizer bypass, harmless today
  because no query text originates from user input.)

### A.5 Access — RLS, roles, membership, audit, plan limits, usage

- **RLS pattern**: every policy delegates to a `SECURITY DEFINER` helper in the
  `private` schema (`private.is_member`, `private.is_admin`,
  `private.can_access_workflow`, `private.is_project_member`) to avoid RLS
  recursion; `private` is never PostgREST-exposed. Org-scoped tables additionally
  require project membership (`projects_select_members`,
  `0054_project_members.sql:183`).
- **Roles**: DB enum `public.org_role` = `member | admin | owner | viewer`
  (`viewer` added `0056`). Mirrored in `packages/schemas/src/can.ts` (`OrgRole`,
  `CAPABILITY_MATRIX`), enforced early (convenience only — RLS is the real boundary)
  via `requireCapability()` middleware
  (`apps/api/src/middleware/requireCapability.ts:15`). Write-grant RPCs are
  admin/owner-only (`0059_write_grants_admin_owner_only.sql`).
- **Project membership**: `project_members` (`0054`), auto-adds the creator via
  trigger; workflow access requires org-admin or project membership (`0055`).
- **Audit**: `audit_log` (general, `private.log_audit`), `log_execution_audit`
  (every `/execute` dispatch, logs query *text* and connector/handle — not row
  data), `log_connection_audit` (lifecycle: updated/deleted/schema_refreshed, field
  names only, never values), `log_copilot_tool_call`, write-grant lifecycle logs.
  Separately, `staff_audit_log` (`0040`) for platform-staff actions, append-only,
  zero authenticated/anon RLS.
- **Plan limits/usage**: `plans` catalog (`0049`) × `org_plan`/`owner_plan`
  (per-org/owner assignment with optional column overrides) enforced by
  `BEFORE INSERT` triggers using `pg_advisory_xact_lock` (TOCTOU-safe). Generic
  metering: `usage_events (kind, subject_id, quantity)` with a `unique(kind,
  subject_id)` idempotency guard, written by `service_role` only, read via
  `SUM(quantity) WHERE occurred_at >= date_trunc('month', now())`. This pattern is
  directly reusable for an `agent_job_run` kind. `llm_usage` (`0068`) tracks
  per-call LLM cost without ever storing prompt/response content — the same
  "metadata only" discipline this plan needs for route 2.

### A.6 The agent today (`apps/agent`)

`apps/agent` is an existing, shipped, on-prem **Planometry sync agent** — strictly
outbound, no inbound listener anywhere in `src/` outside test fixtures.

- **Config**: single JSON file (`agent.config.json`, versioned, `config/types.ts`),
  re-read every 60 s by the scheduler (hot-reload, no restart needed). Connections
  and job secrets are referenced only by opaque UUID `*Ref` fields — never inlined.
- **Jobs**: `SyncJobEntry` (table, strategy `replace|upsertDelta|realtime`, mapping,
  delete mode, schedule) run by `JobScheduler`
  (`apps/agent/src/scheduler/jobScheduler.ts`) — cron/interval timers, a concurrency
  semaphore, and a retry/pause state machine keyed by 13 `RunSyncFailureKind`s
  (transient → backoff retry; config/schemaDrift/etc. → auto-pause).
- **State**: all local JSON files under the agent's home dir — per-job state
  (`job-state/*.json`, watermark, pause state, last error — explicitly *never*
  forwarded to any heartbeat), top-level `state.json`, encrypted `secrets.enc.json`,
  a spool dir, lock dir, key-list dir for delete reconciliation.
- **CLI** (`src/cli/*`, dispatched from `src/index.ts:35`): `version`, `status`,
  `connection add/list/remove/test`, `sql readonly` (generates a least-privilege
  SQL Server login script), `doctor`, `job add/list/test/update/remove/pause/
  resume/run`, `healthcheck`, `start` (daemon mode).
- **Secrets**: single-layer AES-256-GCM, local master key file (`master.key`,
  0o600, protected only by OS permissions — documented limitation), referenced by
  UUID from config. Never sent anywhere; push keys go out only as a Bearer header
  to the Planometry URL and are excluded from the heartbeat payload.
- **Networking**: SQL Server (mssql/tedious) inbound-to-agent is actually
  outbound-from-agent (agent dials out to the DB); Planometry delivery over
  `undici`, gzip JSON bodies; optional heartbeat POST, off by default. No HTTP
  server anywhere.
- **Planometry delivery**: `planometry/client.ts` + `sync/{replaceLoad,upsertPush,
  deletePush,realtimeTick}.ts` already implement the full v4 multi-part protocol —
  `loadId` tracking, byte/row-bounded parts (`requestBuilder.ts`, ≤50k rows / 56 MB),
  per-part retry with backoff, schema-drift pre-check, one documented restart-on-
  mismatch. This is a mature, tested delivery engine we can reuse almost unchanged.
- **Versioning**: agent self-version baked at build time
  (`src/generated/version.ts`); config has its own `CURRENT_CONFIG_VERSION`. There
  is **no existing concept of a platform-pushed "wanted vs. applied" setup
  version** — that is new territory for this plan.

---

## Part B — Design

### B.1 Data model

Reuse, don't duplicate: the "Local database (via agent)" connection itself is just
a new row in the existing `connections` table (`connector_id = 'sqlserver_agent'`,
`config = {agentId, agentConnectionId}`, `vault_secret_ref` unused/nullable for
this connector kind — no secret is ever held platform-side). No new table needed
for the connection itself, and the existing connection-registration pattern
(one manifest + one registry entry) is reused as-is.

Five new tables, three migrations:

1. **`platform_agents`** — paired agent registry. `id, org_id, display_name,
   agent_key_hash, status (pending|active|revoked), agent_version,
   last_check_in_at, created_at`. One org, many agents (per fixed decisions).
2. **`agent_pairing_codes`** — one-time pairing codes. `id, org_id, code_hash,
   created_by_user_id, expires_at, used_at`. *(migration 1, with `platform_agents`)*
3. **`agent_reported_connections`** — the agent's local DB connections, as reported
   on check-in (non-secret only: label, database name, dialect). Backs the Canvas
   dropdown when creating a `sqlserver_agent` connection. `agent_id,
   agent_connection_id, label, metadata jsonb, last_seen_at`. *(migration 1)*
4. **`agent_tasks`** — the task queue (test_connection, list_tables, preview_count,
   read_batch, apply_setup, run_now, pause, resume). `id, agent_id, kind,
   payload jsonb, status (pending|claimed|done|failed), created_at, claimed_at,
   completed_at, result jsonb, error jsonb`. Row payloads for `read_batch` results
   are **not** stored here — they land in a short-TTL Redis key referenced by
   `task.id`, consumed once by the waiting bridge call, to avoid bloating Postgres
   with transient row data. *(migration 2)*
5. **`agent_setups`** — route-2 job definitions (the agent-side analogue of
   `workflow_graphs`). `id, agent_id, connection_id, destination jsonb, schedule,
   wanted_version, applied_version, rejection_reason, updated_at`. *(migration 3)*
6. **`agent_setup_runs`** — route-2 run history, mirrors `workflow_runs`'s shape
   (`status, rows_sent, duration_ms, error, started_at, finished_at`), written from
   the agent's status reports, not by apps/worker. *(migration 3)*

All six get RLS via the existing `private.is_member`/`private.is_admin` helpers,
scoped by `org_id` (agents are always org-scoped, never personal-workspace, since
pairing requires admin/owner — see B.8). Audit reuses `log_connection_audit`-style
field-names-only logging (never config values, never credentials).

### B.2 Agent API

- **Pairing**: `POST /agents/pairing-codes` (admin/owner only) → short code + TTL,
  shown once in the Agents page. On the agent machine: `nia-agent pair --code XXXX
  --url <platform>`. Agent calls `POST /agent-api/pair {code}` → server validates
  against `agent_pairing_codes`, creates `platform_agents` (status `active`),
  returns a long-lived opaque API key **once** (never retrievable again — same
  discipline as write-grant `write_credential_vault_ref`, but here the secret is
  held by the agent, not the platform; the platform stores only `agent_key_hash`).
- **Check-in (long poll)**: `POST /agent-api/check-in` with `Authorization: Bearer
  <agent key>`, body = `{agentVersion, reportedConnections[], jobStatuses[],
  completedTaskResults[]}`. Server updates `last_check_in_at` and
  `agent_reported_connections`, applies any completed-task results, and holds the
  response for up to ~25 s waiting for new pending tasks (classic long-poll, not a
  true streaming connection) before returning `{tasks: []}` if none arrive. The
  transport itself (long poll) is isolated behind an `AgentTransport` interface on
  both ends so it can be swapped for a streaming transport later without touching
  task semantics.
- **Task types**: `test_connection`, `list_tables` (introspect), `preview_count`,
  `read_batch` (route 1: table + columns + filter + cursor + limit), `apply_setup`
  (route 2: push a job spec, wanted-version bump), `run_now`, `pause`, `resume`.
  Each maps to one row in `agent_tasks`.
- **Status/run reports**: separate from individual task completion — a periodic
  summary of job health per `agent_setup` (last run, rows sent, error class),
  folded into the same check-in body (`jobStatuses[]`), which also writes
  `agent_setup_runs`.
- **Auth**: Bearer agent key, compared against `agent_key_hash` (SHA-256, same
  "never store the plaintext" discipline as everything else in this codebase).
- **Versioning**: every call carries `agentVersion`; recorded, not yet enforced.
  Future: a minimum-supported-version gate, same shape as `CURRENT_CONFIG_VERSION`.

### B.3 Offline behaviour and setup versions

An agent is "unreachable" after N missed check-in intervals (e.g. 3× the expected
interval). Tasks are not discarded on disconnect — they sit `pending` with a TTL;
stale tasks past TTL are marked `failed` with a `agent_offline` reason. A route-1
chunk waiting on a `read_batch` task that times out returns a **transient** error
from the bridge, which is the same failure class the worker already retries with
backoff — no new retry logic needed in `runEtl.ts`, only a longer, connector-
specific timeout.

Setup versions follow the "wanted vs. applied" pattern explicitly requested:
`agent_setups.wanted_version` increments on every platform-side edit (new
destination, new schedule, etc.). The agent reports back `applied_version` plus
`rejection_reason` (free text) if it could not apply the wanted setup — e.g.
schema drift, destination not in its local allow-list (B.8), or a Planometry
rejection. The Agents page shows wanted vs. applied with the reason, exactly like
`cred_version` bumps drive connector pool invalidation elsewhere in this codebase.

### B.4 "Local database (via agent)" connection type on the Canvas

New manifest `sqlserver_agent` in `packages/schemas/src/connectors/registry.ts`,
category "database", `operations: ["read"]` only. Its `configSchema` has **no
host/user/password fields** (those live only on the agent machine, per the fixed
decision) — just `agentId` (select from the org's paired agents) and
`agentConnectionId` (select from that agent's `agent_reported_connections`,
populated from check-in sync). The rest of `ConnectionForm.tsx` is unchanged; this
is one more schema-driven form, not a special case.

Browsing/table list: the existing entity picker (`useConnectionEntities` →
`getConnectionSchema`) is unchanged on the Canvas side. On the API side,
`getConnectionSchema()`/`dispatchIntrospect()` gets one new branch: for
`connector_id = 'sqlserver_agent'`, instead of POSTing to a static connector
microservice, it creates a `list_tables` `agent_task` and waits (bounded) for the
agent to answer via check-in — then returns the same `IntrospectResponse` shape
the canvas already expects. Zero changes to `NodeDrawer.tsx`'s entity picker.

### B.5 Route 1 — through Nia Core

Worker reads through the **same** `dispatch()`/`QueryPayload` abstraction, but the
"connector service" this manifest points to is not a stateless microservice — it's
an **agent-dispatch bridge** that speaks the identical `/execute`/`/introspect`/
`/test` HTTP contract `connectorClient.ts` already expects, and internally
translates each call into an `agent_tasks` row + bounded wait + Redis-staged row
fetch. This keeps `connectorClient.ts`, `dispatch.ts`, and `resolveConnection.ts`
unchanged in spirit — the bridge is just "another connector service" from the
worker's point of view.

The one real new concept: `QueryPayload` gets a third variant,
`{kind:"structured", table, columns, filter, cursor, limit}` — because the agent
only runs structured reads, never SQL. A matching guardrail validator
(`packages/guardrails/src/structured.ts`, registered in
`packages/guardrails/src/registry.ts`) checks table/column names are plain
identifiers and `filter` is a small whitelisted comparison-op shape — stricter
than the SQL path, since there is no SQL string to construct in the first place.

Batch upload / back-pressure / temp storage: each ETL chunk (already ≤1000 rows,
keyset-paginated) becomes one `read_batch` task. The agent uploads the batch via a
dedicated endpoint (gzip JSON, same shape discipline as its existing Planometry
delivery code) into a short-TTL Redis key; the bridge's `/execute` response reads
that key once and the key is deleted. Because chunks are already sequential in
`runEtl.ts`, there is naturally at most one in-flight `read_batch` task per
connection — no new back-pressure logic required.

Cancel/timeouts: `getRunCheckpoint()` polling is unchanged; add one cleanup call so
cancelling a run also marks any outstanding `agent_tasks` row for it `failed`. Add
one new timeout constant in `connectorClient.ts` for this manifest (longer than the
15 s static-service default, to allow for a real long-poll round trip) rather than
changing the generic timeout.

**apps/worker files this route would touch (for approval):**
- `apps/worker/src/lib/etl/queryBuilder.ts` — new branch building the `structured`
  `QueryPayload` instead of SQL/Mongo, for this one connector kind.
- `apps/worker/src/lib/connectorClient.ts` — one new timeout constant, no
  structural change (it already just forwards a JSON body).
- `apps/worker/src/lib/dispatch.ts` — none expected (manifestId check already
  generic); flagged in case the structured-query validator surfaces a new error
  shape that needs mapping to a `DispatchResult` error kind.
- `apps/worker/src/lib/resolveConnection.ts` — none expected if `vault_secret_ref`
  is nullable; otherwise a migration change (not a worker code change) to make it
  so for this connector kind.
- No changes expected to `runEtl.ts`'s core loop, checkpointing, or retry logic.

### B.6 Route 2 — direct (agent-delivered)

Destination types live in the agent, reusing what already exists almost
unchanged: Planometry table (apps/agent's existing `replaceLoad`/`upsertPush`/
`deletePush`/`realtimeTick` + `requestBuilder` + `planometry/client.ts`) and a new
generic HTTPS endpoint client built the same way (see B.7).

A Canvas workflow becomes an agent job when its source is `sqlserver_agent` and its
destination is one of these two types: instead of writing `workflow_graphs` and
relying on apps/worker, saving/activating it writes an `agent_setups` row (bumping
`wanted_version`) whose shape is deliberately close to apps/agent's existing
`SyncJobEntry` — table/columns/filter from the source, strategy/mapping/delete-mode
from the destination, schedule. The agent receives it via an `apply_setup` task and
runs it through its existing, already-tested sync engine; the only new code on the
agent is consuming `apply_setup` instead of local CLI `job add`, plus the generic
HTTPS delivery path.

Panels: a slimmed `NodeDrawer` — source panel unchanged (entity picker); destination
panel for Planometry reuses the job-config fields apps/agent already has
(strategy, delete mode, watermark column); destination panel for HTTPS adds
address/auth/batching fields (B.7).

What's unavailable: **transform steps**. The agent has no residual-transform
runtime matching `packages/schemas`' `TransformStep` set (filter/computed_field/
aggregate/etc.) — only field mapping/rename, which the agent already supports.
The Canvas disables inserting a transform node between a `sqlserver_agent` source
and a route-2 destination, with a message to route through Nia Core instead.

### B.7 Generic HTTPS destination

- **Address**: HTTPS only, validated like other config fields in this codebase
  (`connections.config` is already documented as "SSRF-validatable" — same bar
  applies here).
- **Sign-in methods**: API key header, Bearer token, Basic auth — credentials
  entered and stored only on the agent (same `secrets/store.ts` AES-256-GCM local
  store apps/agent already has for push keys).
- **Request shape**: gzip JSON, envelope `{batchId, runNumber, rows: [...]}` — new
  fields vs. today's Planometry envelope, added for idempotency/traceability.
- **Batching/retries**: reuse `requestBuilder.ts`'s row/byte-bounded part-splitting
  and `chunkUploader.ts`'s exponential backoff verbatim.
- **Batch ID / run number**: a fresh UUID per batch, plus a monotonically
  increasing `runNumber` persisted in the agent's job-state file (same file that
  already tracks `lastWatermark`), included on every request.
- **Delivery semantics**: at-least-once, explicitly — there's no two-phase commit
  with an arbitrary third-party endpoint. `batchId` is provided so the destination
  can dedupe if it wants to; this is documented as the destination's
  responsibility, not guaranteed by the agent.
- **"Send all" vs "send changed"**: same `replace`/`upsertDelta` strategy
  vocabulary apps/agent already uses for Planometry, applied to the generic
  destination too — no new vocabulary.

### B.8 Security

- **What reaches the platform per route**: Route 1 — rows and keys genuinely pass
  through Nia Core (that's the point of the route); logged the same way
  `log_execution_audit` already logs query shape today (table/column names, row
  counts — never values). Route 2 — only status, counts, and error *classes* reach
  the platform; actual Planometry rejection text stays on the agent, exactly like
  apps/agent's existing `lastConsoleMessage` field (already documented as
  state-file/CLI-only, never forwarded) — the same restraint extends to generic
  HTTPS destination error bodies.
- **Local allow-list**: for the HTTPS destination, the agent keeps its own
  allow-list of destination hosts, configured locally (CLI, same trust model as
  `connection add`). A platform-issued `apply_setup` whose destination host isn't
  on that list is rejected locally with `rejection_reason = "destination not on
  local allow-list"` — the platform cannot silently redirect where an agent sends
  data.
- **Roles**: pairing a new agent and creating/editing route-2 setups are
  admin/owner-only (same `requireCapability` gate already used for write-grant
  RPCs); reading agent status is any member.
- **Audit**: agent pairing/revocation and every `read_batch`/`apply_setup` task
  logged with `log_connection_audit`-style discipline (shape/counts only, never
  values or credentials).

### B.9 Monitoring

New "Agents" page (web app): paired agents with status (online/offline, derived
from `last_check_in_at`), version, per-agent setups with wanted vs. applied version
and rejection reason, route-2 run history from `agent_setup_runs`. Alerts (email on
"agent offline" or "setup rejected") are listed as an open question (B.11) — not
in scope for the first slices.

### B.10 Slices

1. **Link and Agents page** — *Medium*. Goal: pairing + long-poll check-in works
   end to end; an agent shows up as online in the UI. Files: `platform_agents`,
   `agent_pairing_codes` migration; `apps/api` pairing/check-in routes;
   `AgentTransport` interface; Agents page (list, status). Tests: pairing-code
   issue+consume, check-in updates `last_check_in_at`, expired-code rejection,
   offline-after-N-misses. Real check (timed): pair a real agent process against a
   local stack and see it flip to "online" within 60 s.

2. **Connection type and browsing** — *Medium*. Goal: create a `sqlserver_agent`
   connection on the Canvas and browse its tables. Files: `sqlserver_agent`
   manifest + registry entry; `agent_reported_connections` migration + check-in
   write path; `list_tables` task + bridge branch in `getConnectionSchema`/
   `dispatchIntrospect`; `ConnectionForm` picks up the new schema automatically.
   Tests: create connection from reported list, `list_tables` round trip, stale
   `agent_reported_connections` pruning, permission check (admin-only create).
   Real check (timed): introspect a real local SQL Server table through a real
   paired agent within 30 s.

3. **Route 2 on the Canvas** — *Large*. Goal: a source+Planometry-table or
   source+HTTPS workflow becomes a running agent job, visible in run history.
   Files: `agent_setups`/`agent_setup_runs` migrations; `apply_setup`/`run_now`/
   `pause`/`resume` tasks; Canvas save path branching to `agent_setups` when both
   ends qualify; transform-node disablement; slimmed destination panels; generic
   HTTPS client in `apps/agent` (B.7). Tests: setup apply + version bump, rejection
   reason surfaced (bad allow-list), Planometry delivery via `apply_setup` instead
   of CLI, HTTPS delivery batching/retry. Real check (timed): one real row batch
   delivered to a real Planometry sandbox table via `apply_setup`, confirmed within
   2 minutes.

4. **Route 1** — *Large*. Goal: an ETL run reads a chunk from a real agent through
   Nia Core into an existing destination. Files: `agent_tasks` migration;
   structured `QueryPayload` variant + guardrail validator; `queryBuilder.ts`
   branch; bridge `/execute` implementing `read_batch` + Redis staging;
   `connectorClient.ts` timeout constant; cancel cleanup hook. Tests: structured
   query validation (reject bad table/column names), one-chunk round trip, timeout
   → transient retry, cancel mid-task. Real check (timed): a full small-table ETL
   run from a real local SQL Server through a real agent into Postgres, completed
   within 5 minutes.

5. **Hardening and delivery** — *Medium*. Goal: production-shaped edges closed.
   Files: local allow-list enforcement end to end; audit logging for every new
   task kind; `agent_key_hash` rotation path; minimum-agent-version gate; usage
   metering (`usage_events` kind `agent_job_run`). Tests: allow-list rejection,
   audit rows for pairing/read_batch/apply_setup, old-version agent rejected,
   usage event idempotency. Real check (timed): full pairing→browse→route-1-run→
   route-2-run smoke, start to finish, under 10 minutes.

### B.11 Open questions (with recommended defaults)

1. **Who uses the Agents/pairing screens?** Recommended: admin/owner only (matches
   write-grant precedent); members can view status read-only.
2. **Do agent job runs count against plan limits?** Recommended: yes, reuse
   `usage_events` with `kind = 'agent_job_run'` (route 2) and the existing
   `rows_moved` kind (route 1, already counted since it's a normal worker run) —
   keeps one metering model instead of a parallel one.
3. **Email alerts on agent offline / setup rejected?** Recommended: not in the
   first five slices; add once the Agents page and run history have been used for
   a while and real alert thresholds are known, to avoid guessing at noise levels.

---

**Commit note**: this document only. No code changes, no push.
