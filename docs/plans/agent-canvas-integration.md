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

### B.1 Permissions

Agents are scoped exactly like connections today: `org_id` (a personal workspace
is itself an org row, per the existing individual-workspace-as-org design —
`0005_individual_workspace.sql`), not a separate "agents are org-only" rule. Any
**member** can pair an agent, create `sqlserver_agent`/`planometry_table`/
`https_endpoint` connections, and publish/run-now/pause/resume a route-2 setup —
these are treated as connection-and-workflow actions, which members already have
today. **Viewers** are read-only on all of it (Agents page, setups, run history),
matching the existing `viewer` role restrictions (`0057_viewer_role_restrictions.sql`).
**Revoking or removing an agent** (and, since it's equally sensitive, rotating its
key) is restricted to admins, owners, and the specific member who paired it —
a new helper `private.can_manage_agent(agent_id)` (admin/owner OR
`platform_agents.created_by_user_id = current_user`), mirrored in
`packages/schemas/src/can.ts`. Local connections (`sqlserver_agent`,
`planometry_table`, `https_endpoint`) and the workflows built on them keep the
*existing* project-membership and workflow-access rules unchanged — nothing about
being agent-backed changes who can see or edit a given workflow.

### B.2 Data model — six new tables, three migrations

Reuse, don't duplicate: `sqlserver_agent`, `planometry_table`, and `https_endpoint`
(B.6) are all just rows in the existing `connections` table via the existing
one-manifest-one-registry-entry pattern — no new table for any connection type
itself.

Six new tables:

1. **`platform_agents`** — paired agent registry. `id, org_id, created_by_user_id,
   display_name, agent_key_hash, status (pending|active|revoked), agent_version,
   last_check_in_at, created_at`.
2. **`agent_pairing_codes`** — one-time pairing codes (B.12). `id, org_id,
   created_by_user_id, code_hash, expires_at, attempt_count, max_attempts,
   used_at, created_at`.
3. **`agent_reported_connections`** — the agent's local DB connections as reported
   on check-in (non-secret: label, database name, dialect). Backs the picker when
   creating a `sqlserver_agent` connection. `agent_id, agent_connection_id, label,
   metadata jsonb, last_seen_at`.
4. **`agent_tasks`** — the task queue (test_connection, list_tables, preview_count,
   read_batch, apply_setup, run_now, pause, resume). `id, agent_id, kind,
   payload jsonb, status (pending|claimed|done|failed), created_at, claimed_at,
   completed_at, result jsonb, error jsonb`. `payload`/`result` never contain
   secret values (B.6) or row data (`read_batch` rows are staged in Redis, B.9, and
   `run_now`/`apply_setup` secrets are pulled by the agent through a separate
   authenticated endpoint, B.6) — only shapes/identifiers/counts.
5. **`agent_setups`** — route-2 job definitions, created only by Publish (B.7).
   `id, workflow_id (FK workflows, nullable), local_job_id (text, nullable),
   source (platform|local), agent_id, connection_id, destination_connection_id,
   wanted_version, applied_version, rejection_reason, updated_at`. Exactly one of
   `workflow_id`/`local_job_id` is set (`CHECK`) — a platform-published setup
   always carries a `workflow_id`; a CLI-only job reported via check-in (B.11) has
   no `workflow_id`, only a `local_job_id`, and `source = 'local'`.
6. **`agent_setup_runs`** — route-2 run history. `id, agent_setup_id, run_id
   (unique — the outbox idempotency key, B.7), status, rows_sent, duration_ms,
   error, started_at, finished_at, is_realtime_aggregate, period_start,
   period_end`.

RLS: tables 1–4 use `private.is_member` for read, `private.can_manage_agent` for
pair/revoke/rotate, and plain membership for create/publish/run-now/pause/resume
(B.1). Tables 5–6 (`agent_setups`/`agent_setup_runs`) reuse
**`private.can_access_workflow(workflow_id)`** directly — the same helper
`workflow_graphs`/`workflow_runs` already use — for `source = 'platform'` rows;
`source = 'local'` rows (no `workflow_id`) fall back to plain org membership via
`agent_id`'s org. No new RLS pattern is introduced.

Migration numbers are **not** fixed here: the current HEAD is `0068`
(`llm_usage`), but this plan assumes v1.1.0 ships first, so these six tables land
as whatever immediately follows HEAD at that point — illustrated below as
`0069`–`0071`, to be renumbered at implementation time:
`0069_platform_agents.sql` (tables 1–2), `0070_agent_reported_connections_and_tasks.sql`
(tables 3–4), `0071_agent_setups.sql` (tables 5–6).

### B.3 Agent API

- **Pairing** (B.12 has exact code parameters): `POST /agents/pairing-codes` (any
  member) → short code + TTL, shown once on the Agents page. Agent runs `nia-agent
  pair --code XXXX --url <platform>` → `POST /agent-api/pair {code}` validates
  against `agent_pairing_codes`, creates `platform_agents` (status `active`,
  `created_by_user_id` = the pairing member), returns a long-lived opaque API key
  **once** — the platform stores only `agent_key_hash`.
- **Check-in (long poll)**: `POST /agent-api/check-in`, `Authorization: Bearer
  <agent key>`, body = `{agentVersion, reportedConnections[], jobStatuses[],
  runReports[], completedTaskResults[]}`. Server updates `last_check_in_at`,
  `agent_reported_connections`, acks `runReports[]` (B.7's outbox), applies
  `completedTaskResults[]`, and holds the response up to ~25 s waiting for new
  pending tasks before returning `{tasks: []}`. Isolated behind an
  `AgentTransport` interface on both ends so long-polling can be swapped later.
- **Task types**: `test_connection`, `list_tables`, `preview_count`, `read_batch`
  (route 1), `apply_setup` (route 2, B.7), `run_now` (B.8, carries one-off param
  overrides and an `allowMassDelete` flag), `pause`, `resume`.
- **Secret fetch (new, not a task)**: `GET /agent-api/connections/:connectionId/secret`,
  Bearer agent key, returns the plaintext secret for a `planometry_table` or
  `https_endpoint` connection the agent has been told (via `apply_setup`) to
  deliver to. Called by the agent on-demand, right before it needs the secret;
  the secret is stored in the agent's existing local encrypted store afterwards
  and is never embedded in `agent_tasks.payload` or any log line (B.6).
- **Auth**: Bearer agent key vs. `agent_key_hash` (SHA-256).
- **Versioning**: every call carries `agentVersion`; recorded, not yet enforced
  (minimum-version gate is slice 5 / B.13).

### B.4 Offline behaviour and setup versions

**Nothing changes in the agent's own scheduling when the platform is
unreachable.** `JobScheduler` (A.6) is already fully local — it re-reads
`agent.config.json`/job-state and fires cron/interval timers with zero dependency
on reaching the platform per tick. A platform outage only affects two things: (a)
no *new* `apply_setup`/`run_now`/`pause`/`resume` tasks arrive until check-in
reconnects, and (b) run reports queue in the local outbox (B.7) instead of being
acked. Every setup the agent has already applied keeps running on its existing
schedule throughout.

An agent is "unreachable" (platform's view) after N missed check-in intervals.
Pending tasks aren't discarded — they sit with a TTL and expire `failed` with
`agent_offline` if the agent never reconnects in time. A route-1 chunk waiting on
a `read_batch` task that times out returns a **transient** error from the bridge
— the same class the worker already retries with backoff.

`agent_setups.wanted_version` increments only on Publish (B.7, never autosave).
The agent reports `applied_version` + `rejection_reason` on check-in — schema
drift, destination not on the local allow-list (B.10), a Planometry rejection, or
an untranslatable filter (B.7). The Agents page shows wanted vs. applied + reason,
the same spirit as `cred_version` bumps driving pool invalidation elsewhere.

### B.5 The bridge — one design

**One service, two listeners, no per-connector branch anywhere in apps/api or
apps/worker.** This resolves the earlier draft's contradiction between "the
bridge is just another connector service" (B.5/B.9) and "`getConnectionSchema`
gets a new branch" (B.4) — there is no branch; the manifest's `service.host/port`
field points straight at the bridge, exactly like every other connector.

- **Internal listener** (e.g. `agent-bridge:4041`) — `/test`, `/introspect`,
  `/execute`. Called by `apps/api`'s `connectorDispatch.ts` and
  `apps/worker`'s `connectorClient.ts` with **no code change to either file beyond
  what any new connector manifest already requires** — same `signReadContext()`/
  `verifyReadContext()` HMAC scheme (`WRITE_DISPATCH_SIGNING_SECRET`) the three
  existing connector services use (A.3/A.4 research: this is HMAC-signed, not
  just network trust, so the bridge must verify it identically). Never published
  in `docker-compose.prod.yml` (no `ports:`), never routed by nginx or Next's
  `/api/backend` rewrite — same isolation as `connector-mysql`/`-mongodb`/
  `-supabase` today.
- **Public listener** (e.g. `agent-bridge:4040`, proxied by nginx at
  `/agent-api/*` — deliberately **not** under `/api/backend`, which stays
  reserved for `apps/api`) — `/pair`, `/check-in`, `/tasks/:id/upload`,
  `/connections/:id/secret`. This is the only piece of this plan reachable from
  the public internet by design, since real agents dial in from outside the
  docker network.

Internally, the two listeners share the same `agent_tasks` row store: the
internal side *creates* tasks (and bounded-waits on them for `/execute`), the
public side is where a real agent *claims and completes* them via check-in.

### B.6 "Local database (via agent)" connection type on the Canvas

New manifest `sqlserver_agent`, category "database", `operations: ["read"]` only.
`configSchema` has **no host/user/password fields** — just `agentId` and
`agentConnectionId` (picked from `agent_reported_connections`). Introspection goes
through the bridge's internal listener exactly like any connector (B.5) — zero
special-casing in `getConnectionSchema()`/`dispatchIntrospect()`, zero change to
`NodeDrawer.tsx`'s entity picker.

### B.7 Destinations are connection types; publishing is explicit

**Planometry table** and **generic HTTPS endpoint** are *platform* connection
types, not agent-only concepts:

- `planometry_table` manifest: `configSchema = {tableUrl}` + secret (API key),
  created through the normal `ConnectionForm`/`createConnectionAction` path,
  secret stored in `nia_secrets` like any connection. `service.host/port` points
  at a small new connector service that calls Planometry **directly from the
  platform** for `/test` and `/introspect` (reusing apps/agent's existing
  `planometry/client.ts` schema-fetch shape) — so the existing `MappingEditor`
  and `checkMappings` work completely unchanged, because this is "just another
  introspectable destination" from the Canvas's point of view.
- `https_endpoint` manifest: `configSchema = {address, authMethod}` + secret
  (API key / bearer token / basic auth). `/test` is a reachability ping; `/introspect`
  returns no schema (an arbitrary endpoint has nothing to introspect) — the
  mapping UI falls back to manual target-field entry for this one connector kind,
  same fallback already needed for any schemaless destination.
- **Secrets never ride in `agent_tasks`.** `apply_setup`'s payload references
  `destination_connection_id` only. On receiving `apply_setup`, the agent calls
  the new `GET /agent-api/connections/:id/secret` (B.3) to pull the plaintext
  once, over its own outbound HTTPS call, and stores it in its existing local
  encrypted store — identical discipline to a CLI-entered push key, just sourced
  from the platform instead of stdin.

**Publishing**: the graph always autosaves to `workflow_graphs` exactly as today
(A.2), regardless of route — autosave never touches `agent_setups`. A **Publish**
action (visible only when source = `sqlserver_agent` and destination =
`planometry_table`/`https_endpoint`) is the sole writer of `agent_setups`:

1. Derives the job spec from the current graph (source table/columns/filter,
   destination mapping/mode/schedule — B.7's field map below).
2. Diffs it against the currently-applied setup and shows what will change,
   explicitly flagging anything that **forces a full reload** — switching source
   table, changing key/watermark columns, or switching mode away from
   `upsertDelta`/`realtime` — versus an in-place change (schedule, column
   mapping, filter value).
3. On confirm, upserts `agent_setups` and bumps `wanted_version`; the agent picks
   it up via `apply_setup` on its next check-in (B.4 covers rejection reporting).

**Where each route-2 setting lives**, since several of these don't exist in the
schema yet and are called out as new rather than assumed:

| Setting | Lives on | Status |
|---|---|---|
| Column selection | Source node (new `columns: string[]` on `SourceDestConfig`, defaulting to all introspected columns) | **New** — today's source panel has no column UI (A.2); the agent needs an explicit list, never `SELECT *`. |
| Mapping | Destination node, existing `MappingEditor` tab (`NodeDrawer.tsx` `showMappingTab`) | Reused unchanged. |
| Filter | Existing `filter` `TransformStep` between source and destination | Reused **only** when it is the flat `FilterCondition[]` AND-chain shape (what the row editor always produces); Publish's diff step (above) runs the existing `exprToConditions`-style check and blocks publish with a plain message ("this filter is too complex for direct delivery — route it through Nia Core instead") if the saved step is a full `Expr` tree with `or`/`not`/computed fields. |
| Parameters / rolling dates | **New** — doesn't exist in `packages/schemas` today (confirmed: no `params` field, no rolling-date type anywhere in `nodeConfig.ts`/`graph.ts`). Proposed: a new `params` map on the source node's config, with a `rollingDate(offset)` literal usable inside the filter. Maps onto apps/agent's **already-existing** `SyncJobEntry.params`/`filter` placeholder substitution (A.6) — the gap is entirely platform-side schema/UI, not agent-side. | **New**, platform-side only. |
| Mode (replace / upsertDelta / realtime) | Destination node, new route-2-only "Delivery" section | **New** section, reusing apps/agent's existing enum. |
| Watermark column | Same "Delivery" section | **New** UI, existing agent concept. |
| Delete method + safety (null-key policy, empty-replace guard, max-delete %) | Same "Delivery" section, "Safety" subsection | **New** UI, existing agent concepts (`onNullKey`, `allowEmptyReplace`, `maxDeletePercent`). |
| Schedule / replace schedule / poll interval | Same "Delivery" section, "Schedule" subsection | **New** UI, existing agent concepts. |

**Run reports — outbox, idempotent, aggregated for realtime**: the agent appends
one run-report record per completed run to a local outbox file (same durability
class as `job-state/*.json`), includes outstanding outbox entries in every
check-in body (`runReports[]`), and only drops an entry once the server acks it
by `run_id` in the check-in response. The server upserts `agent_setup_runs` on
`run_id` (unique), so resends are idempotent. **Realtime jobs do not report per
tick** — the agent accumulates `realtimeTick` results over a period (e.g. 60s)
and emits one aggregated `agent_setup_runs` row per period
(`is_realtime_aggregate = true`, `period_start`/`period_end`, summed rows).

**Route-2 runs in the workflow's run history, not only the Agents page**: extend
`listRunsForWorkflow` (`apps/api/src/services/runs.ts:219` — today only called by
Copilot tools, no browser route exists yet per research) to also select
`agent_setup_runs` joined through `agent_setups.workflow_id = workflowId`, union
with `workflow_runs`, tag each row with its source (`worker`/`agent`), order by
`started_at`. Exposed via a new `GET /workflows/:id/runs` — which is needed
anyway, since no run-history route exists at all today.

**What's unavailable**: every transform step except the (translatable) `filter`
— the agent has no residual-transform runtime for `computed_field`/`aggregate`/
`to_json`/`flatten`/`drop_fields`. The Canvas disables inserting any of those
between a `sqlserver_agent` source and a route-2 destination, with a message to
route through Nia Core instead.

### B.8 Actions

- **Test**: dispatches `test_connection` for the source plus the destination's own
  `/test` (called directly by the platform, B.7) — validates reachability without
  running anything.
- **Run now** (one-off param values): a dialog collecting current values for the
  setup's `params` (B.7), sent as a `run_now` task carrying overrides that are
  **not** persisted to `agent_setups` — a single run only.
- **Force full reload**: a `run_now` variant that resets the watermark and runs
  once in `replace` semantics, regardless of the setup's normal mode.
- **Pause / resume**: `pause`/`resume` tasks, mirroring the existing CLI commands.
- **Allow one large delete**: a confirmation checkbox required when a `run_now`
  would exceed `maxDeletePercent`; checking it sends `run_now {allowMassDelete:
  true}`, passed straight through to the agent's existing massDelete guard
  (today gated by the CLI's `--allow-mass-delete` flag, A.6) — a one-time
  override, not a setup change.

### B.9 Route 1 — through Nia Core

Unchanged core idea: a third `QueryPayload` variant, `{kind:"structured", table,
columns, filter, cursor, limit}`, validated by a new guardrail
(`packages/guardrails/src/structured.ts`) that checks plain identifiers and a
whitelisted comparison-op filter — stricter than the SQL path since there's no
SQL string at all.

**Every apps/worker file that builds a query for a source** needs the same new
`structured` branch (listed for approval, per the research above):

- `apps/worker/src/lib/etl/queryBuilder.ts` — `buildEtlReadQuery` (per-chunk read)
  and `buildFailurePreCheckQuery` (pre-count for a `FailurePreCheck` step).
- `apps/worker/src/lib/preview/runPreview.ts` — `buildPreviewQuery` (one-shot
  preview with field aliasing).
- `apps/worker/src/lib/profile/sampleEntity.ts` — `buildSqlPage`/`buildMongoPage`
  (profiler keyset sampling) and the inline unkeyed-page fallback.
- `apps/worker/src/lib/connectorClient.ts` — one new timeout constant for this
  manifest (longer than the 15s static-service default, to allow a real
  long-poll round trip).
- `apps/worker/src/lib/dispatch.ts`/`resolveConnection.ts` — none expected
  (both already fully generic); `vault_secret_ref` nullability for this
  connector kind is a migration concern, not a worker code change.
- No change to `runEtl.ts`'s core loop, checkpointing, or retry logic.

**Byte cap and concurrency, new**: each `read_batch` response is capped at **5 MB**
uncompressed JSON (not Planometry's 56 MB — this rides inside one long-poll
response cycle, not a dedicated bulk upload) in addition to the existing
`MAX_CHUNK_ROWS = 1000`. The agent enforces a new `maxConcurrentAgentTasks`
semaphore (default 1), separate from `maxConcurrentRuns` (A.6, route-2 jobs), so
ad hoc route-1 reads can't starve the agent's own scheduled route-2 jobs.

**What this route is for**: each chunk costs one full long-poll round trip
(dominated by check-in cadence, not raw transfer — realistically single-digit
seconds per chunk at best). That puts sustained throughput in the tens-to-low-
hundreds of rows/second, **not** a bulk-transfer rate. Route 1 is sized for
small-to-medium tables (comfortably up to roughly 1–2 million rows at a run
duration of tens of minutes); large fact tables should use route 2's Planometry
delivery (which bypasses the per-chunk round trip entirely via the agent's own
direct multi-part upload) instead.

Batch staging and cancel are unchanged from the earlier draft: rows land in a
short-TTL Redis key per task, read once by the bridge's `/execute` response; a
cancelled run also marks its outstanding `agent_tasks` row `failed`.

### B.10 Security

- **What reaches the platform per route**: Route 1 — rows and keys genuinely pass
  through (that's the route's purpose), logged the same shape-only way
  `log_execution_audit` already logs query shape (names/counts, never values).
  Route 2 — only status, counts, and error *classes*; rejection text (Planometry
  or otherwise) stays on the agent, exactly like the existing `lastConsoleMessage`
  field (A.6, already state-file/CLI-only).
- **Local allow-list covers every route-2 destination host, Planometry
  included** — not just the generic HTTPS case. A platform-issued `apply_setup`
  whose destination host (Planometry's `tableUrl` host or an `https_endpoint`
  address) isn't on the agent's local allow-list is rejected locally with
  `rejection_reason = "destination not on local allow-list"`.
- **Roles**: per B.1 — pair/create/publish/run-now/pause/resume = any member;
  revoke/remove/rotate = admin, owner, or the pairing member.
- **Audit**: agent pairing/revocation/rotation and every `read_batch`/
  `apply_setup`/`run_now` task logged with `log_connection_audit`-style
  discipline (shape/counts only).

### B.11 Local CLI jobs stay supported, visible read-only

A job created by `nia-agent job add` (A.6) continues to work exactly as today —
nothing about this plan changes the CLI. On check-in, the agent additionally
reports status for **all** jobs it knows about, not just platform-published
ones; a job with no matching `apply_setup` origin is upserted into `agent_setups`
with `source = 'local'`, `workflow_id = NULL`, `local_job_id` set, and no
`wanted_version` the platform ever writes. The Agents page lists these alongside
platform-managed setups, clearly marked "local," with status and
`agent_setup_runs` history visible but no Publish/run-now/pause/resume controls
exposed for them — they stay entirely CLI-owned.

### B.12 Pairing and keys

- **Pairing code**: 8-character base32 (excludes `0/O/1/I` to avoid transcription
  errors), 15-minute expiry, **5 attempts** before the code is invalidated and a
  new one must be issued (`agent_pairing_codes.attempt_count`/`max_attempts`).
- **Revoke**: sets `platform_agents.status = 'revoked'`; every subsequent
  check-in is rejected immediately. Available from the Agents page to admins,
  owners, and the pairing member (B.1).
- **Key rotation**: issues a new `agent_key_hash`, returns the new plaintext key
  once (same "shown once" discipline as pairing), invalidates the old key
  atomically in the same transaction. Same role gate as revoke, since it's
  equally sensitive.

### B.13 Monitoring

Agents page: paired agents (status derived from `last_check_in_at`), version,
per-agent setups (platform-managed and local, B.11) with wanted vs. applied
version and rejection reason, route-2 run history. Route-2 runs also surface in
the owning workflow's own run history (B.7). Alerts (email on offline/rejected)
stay an open question (B.14) — not in the first five slices.

### B.14 Slices

**Migrations are numbered after `0068` and assume v1.1.0 ships first** — numbers
below are illustrative (`0069`+), to be renumbered against whatever HEAD actually
is at implementation time.

1. **Link** — *Medium*. Goal: pairing, check-in, and the run-report outbox work
   end to end; an agent shows up on the Agents page. Files: `platform_agents` +
   `agent_pairing_codes` migration (`0069`); bridge public listener (`/pair`,
   `/check-in`); `AgentTransport` interface; `private.can_manage_agent`; Agents
   page (list, status, revoke, rotate). Tests: pairing-code issue/consume/expiry/
   attempt-limit, check-in updates `last_check_in_at`, outbox ack-by-run_id is
   idempotent, offline-after-N-misses. **Real check** (≤60s): sandbox = Postgres +
   Redis + bridge only (no SQL Server needed yet) — pair a real agent process and
   see it flip to "online."

2. **Connection** — *Medium*. Goal: create a `sqlserver_agent` connection and
   browse its tables through the bridge's internal listener. Files:
   `sqlserver_agent` manifest + registry entry; `agent_reported_connections`
   migration (`0070`, with `agent_tasks`); `list_tables` task; bridge internal
   listener (`/test`, `/introspect`) with HMAC verification (B.5).
   Tests: create connection from reported list, `list_tables` round trip, stale
   row pruning, permission check (any member can create). **Real check** (≤30s):
   sandbox = Postgres + Redis + bridge + one real agent pointed at an
   **external** SQL Server via env vars (`SQLSERVER_HOST`/`PORT`/`USER`/
   `PASSWORD` — no local SQL Server container on an 8 GB machine) — introspect a
   real table.

3. **Route 2** — *Large*. Goal: Publish turns a source+Planometry-table or
   source+HTTPS workflow into a running, monitorable agent job. Files:
   `planometry_table`/`https_endpoint` manifests + their connector service (direct
   Planometry test/introspect); `agent_setups`/`agent_setup_runs` migration
   (`0071`); secret-fetch endpoint; `apply_setup`/`run_now`/`pause`/`resume`
   tasks; Publish action + diff/full-reload UI; new column-selection/params/
   delivery-section panels; transform-step disablement; generic HTTPS sender in
   `apps/agent`; run-history merge (B.7). Tests: Publish diff flags a full-reload
   change correctly, untranslatable filter blocks publish with a clear message,
   realtime aggregation produces one run row per period, local-allow-list
   rejection surfaces as `rejection_reason`. **Real check** (≤2 min): sandbox =
   Postgres + Redis + bridge + agent (external SQL Server via env) + a real
   Planometry **staging** table (no local Planometry) — one published setup
   delivers one real batch.

4. **Route 1** — *Large*. Goal: an ETL run reads a chunk from a real agent through
   Nia Core into an existing destination. Files: `structured` `QueryPayload` +
   guardrail validator; the four query-builder files in B.9; bridge `/execute`
   (read_batch + Redis-staged batch upload, 5 MB cap); `connectorClient.ts`
   timeout constant; `maxConcurrentAgentTasks` semaphore; cancel cleanup. Tests:
   structured-query validation rejects bad identifiers, one-chunk round trip,
   byte-cap enforcement, cancel mid-task. **Real check** (≤5 min): sandbox =
   Postgres + Redis + bridge + agent (external SQL Server via env) + worker,
   destination = the same Postgres sandbox — a full small-table ETL run end to
   end.

5. **Delivery** — *Medium*. Goal: production-shaped edges closed and the
   installer ships. Files: local allow-list enforcement end to end (Planometry
   included); audit logging for every new task kind; key rotation; minimum-
   agent-version gate; usage metering (B.15); a route-2 test asserting **no row
   or key value ever reaches the platform** (static grep over `agent_tasks`
   payload shapes plus a live run with network capture); installer packaging +
   pairing docs. Tests: allow-list rejection (Planometry host too), audit rows
   present for pairing/rotation/read_batch/apply_setup, old-version agent
   rejected, the no-row-reaches-platform test itself. **Real check** (≤10 min):
   the full stack, plus the one test genuinely meant to stress this — **a real
   Windows machine, a real cloud SQL Server, and a real Planometry staging
   table**, pairing → browse → publish → route-1 run → route-2 run, start to
   finish.

### B.15 Open questions (with recommended defaults)

1. **Do agent job runs count against plan limits?** Recommended: yes — route 2
   rows count toward the monthly row limit via `usage_events`
   (`kind = 'agent_rows_sent'`, `subject_id = run_id`, naturally idempotent
   through the outbox's run_id dedup, B.7); route 1 is already counted as a
   normal worker run.
2. **What exactly gets counted, given overlap re-sends?** `upsertDelta`/
   `realtime`'s `overlapSeconds` (A.6) deliberately re-reads some already-sent
   rows on the next run to catch late changes, which inflates a naive "rows sent
   this run" counter. Recommended default: count what the agent reports as rows
   sent per run, documented explicitly as an approximation that can overcount
   during overlap windows — simplest to implement now; revisit with a
   distinct-keys-per-period measure only if the overcounting proves material in
   practice.
3. **Email alerts on agent offline / setup rejected?** Recommended: not in the
   first five slices; add once the Agents page and run history have real usage
   to calibrate alert thresholds against.

---

**Commit note**: this document only. No code changes, no push.
