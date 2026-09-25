import { readFileSync } from "node:fs";
import Fastify from "fastify";
import {
  TestRequest,
  IntrospectRequest,
  ExecuteRequest,
  InvalidateRequest,
  WriteRequest,
  StageRequest,
  PreflightRequest,
  CreateEntityRequest,
  DropEntityRequest,
  rowsNeedJsonCoercion,
  coerceJsonWriteValues,
  type TabularResult,
  type WriteResponse,
  type StageResponse,
  type PreflightResponse,
  type AssertionResult,
  type WriteEntityRef,
  type CreateEntityResponse,
  type DropEntityResponse,
  type ReadContext,
} from "@nia/schemas";
import { getPool, getWritePool, evict, poolCount, verifyActiveWriteGrant, checkSupabaseReachable } from "./pool-manager.js";
import { mapPostgresColumnType } from "./column-types.js";
import { executeWithStatementTimeout } from "./query.js";
import { verifyWriteContext, verifyReadContext, HttpError } from "./writeSignature.js";
import { buildUpsertSql, buildCreateTableSql, buildEnableRlsSql, buildDropTableSql } from "./writeSql.js";
import { buildIntrospectPrivilegeSql } from "./rlsSql.js";
import {
  buildCreateStagingSql,
  buildDropStagingSql,
  buildCreateQuarantineSql,
  buildQuarantineInsertSql,
  buildQuarantineCommitSql,
  buildQuarantineDeletePendingSql,
  buildQuarantineCountSql,
  buildStagingCountSql,
  buildApplyFromStagingSql,
  buildAssertionQuery,
  buildAdvanceSequencesSql,
} from "./stagingSql.js";

function entityMatches(a: WriteEntityRef, b: WriteEntityRef): boolean {
  return a.namespace === b.namespace && a.name === b.name;
}

/**
 * Stage 5 production-readiness pass — verifies the lighter ReadContext
 * (contract.ts) attached to /test, /introspect, /execute, /invalidate,
 * /preflight. Mirrors /write's verifyWriteContext+HttpError(401) pattern
 * below, just against the smaller read-side payload shape. `route` is
 * always the literal call-site string, never taken from the request body,
 * so a signature captured for one route can't be replayed against
 * another. `queryPayload` is only non-null for /execute (binds the signed
 * context to the exact query text/params, not just the connectionId).
 */
function verifyReadRequest(
  route: "test" | "introspect" | "execute" | "invalidate" | "preflight",
  connectionId: string,
  context: ReadContext,
  queryPayload: unknown = null,
): void {
  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const valid = verifyReadContext(
    {
      route,
      connectionId,
      queryPayload: queryPayload === null ? null : JSON.stringify(queryPayload),
      issuedAt: context.issuedAt,
    },
    context.signature,
    secret,
  );
  if (!valid) throw new HttpError(401, "read context signature is invalid or expired");
}

/**
 * Bug fix: pg_namespace-first check, same pattern as /create-entity's
 * schemaCheck below and /preflight's create-schema-nia check — shared by
 * /stage and /write's quarantine-write branch so neither re-issues
 * `CREATE SCHEMA IF NOT EXISTS "nia"` (which needs database-level CREATE)
 * once the admin-run grant DDL has already created it for a role that
 * only ever holds schema-scoped CREATE on "nia".
 */
async function checkNiaSchemaExists(queryable: { query: (sql: string) => Promise<{ rowCount: number | null }> }): Promise<boolean> {
  const r = await queryable.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'nia'`);
  return (r.rowCount ?? 0) > 0;
}

/**
 * Bug fix: `nia.nia_quarantine` is a single fixed table shared across every
 * write grant on the same database (stagingRegistry.ts's
 * deriveQuarantineEntity) — skip re-enabling RLS on it once it's already
 * on, so a role that isn't its owner doesn't hit "must be owner of table
 * nia_quarantine" (see stagingSql.ts's buildCreateQuarantineSql doc
 * comment).
 */
async function checkQuarantineRlsEnabled(queryable: { query: (sql: string) => Promise<{ rows: unknown[] }> }): Promise<boolean> {
  const r = await queryable.query(
    `SELECT c.relrowsecurity AS enabled FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'nia' AND c.relname = 'nia_quarantine'`,
  );
  const row = r.rows[0] as { enabled: boolean } | undefined;
  return Boolean(row?.enabled);
}

/**
 * connector-supabase — direct Postgres access (targets a Supabase project's
 * underlying Postgres, not its REST/PostgREST API). Same uniform contract as
 * connector-mysql/connector-mongodb: /test /introspect /execute /invalidate
 * /health, plus /write (Phase 6 Block 2 — this connector's etl_sink
 * capability; the first connector to get the write path, per the kickoff
 * spec).
 *
 * The worker sends dialect-native, guardrail-approved (postgres dialect)
 * queries. This service's jobs are pooling, execution, and normalization to
 * the tabular shape.
 */

const app = Fastify({ logger: true });

// BUILD_HASH is baked in by the Dockerfile (scripts/compute-build-hash.mjs)
// at image build time. Reading it fails silently outside Docker (local
// `tsx` runs) since the file only exists inside the built image.
let buildHash = "dev";
try {
  buildHash = readFileSync("BUILD_HASH", "utf8").trim();
} catch {
  // Not running from the built image (e.g. local dev via tsx) — leave "dev".
}

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-supabase",
  buildHash,
  pools: poolCount(),
  routes: ["test", "introspect", "execute", "invalidate", "write", "stage", "preflight", "create-entity", "drop-entity"],
}));

app.post("/test", async (req) => {
  const { credential, config, context } = TestRequest.parse(req.body);
  verifyReadRequest("test", credential.connectionId, context);
  const start = Date.now();
  try {
    const pool = await getPool(credential, config);
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
});

// Hard-excluded from every /introspect response, regardless of the
// client-side "Show system schemas" toggle (NodeDrawer.tsx's
// SYSTEM_SCHEMAS list): `nia` is Nia's own staging/quarantine schema and
// must never be offered as a source or destination, and `vault` holds
// Supabase's encrypted secrets and must never be readable/writable through
// a workflow, even with the toggle on. This exclusion happens here, not
// just client-side, so no client bug can ever surface either schema.
const HARD_EXCLUDED_SCHEMAS = ["information_schema", "pg_catalog", "pg_toast", "nia", "vault"];

app.post("/introspect", async (req) => {
  const { credential, config, context } = IntrospectRequest.parse(req.body);
  verifyReadRequest("introspect", credential.connectionId, context);
  const pool = await getPool(credential, config);
  const result = await pool.query(
    `SELECT table_schema, table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema != ALL($1::text[])
     ORDER BY table_schema, table_name, ordinal_position`,
    [HARD_EXCLUDED_SCHEMAS],
  );
  // Postgres's information_schema.columns has no PK flag of its own (unlike
  // MySQL's column_key) — primary-key columns are discovered separately and
  // merged in below. Phase 6 Block 3.5: backs IntrospectResponse's
  // per-entity primaryKey used for the ETL runner's keyset pagination.
  //
  // Phase 10 fix: this MUST go through pg_catalog (pg_index/pg_class/
  // pg_attribute), not information_schema.table_constraints +
  // key_column_usage. Those information_schema views only show a
  // constraint to the querying role if it has a table privilege OTHER
  // than SELECT (owner, INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER)
  // — see the Postgres docs' privilege note on table_constraints. Every
  // real connection here authenticates as a read-only (SELECT-only) role,
  // so the old query silently returned zero rows for every table, always
  // reporting primaryKey: null and permanently disabling keyset
  // pagination for postgres/supabase connections. pg_catalog system
  // tables aren't subject to that restriction.
  const pkResult = await pool.query(
    `SELECT n.nspname AS table_schema, c.relname AS table_name, a.attname AS column_name
     FROM pg_index i
     JOIN pg_class c ON c.oid = i.indrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
     WHERE i.indisprimary
       AND n.nspname != ALL($1::text[])
     ORDER BY n.nspname, c.relname, a.attnum`,
    [HARD_EXCLUDED_SCHEMAS],
  );
  const pkColsByEntity = new Map<string, string[]>();
  for (const r of pkResult.rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!pkColsByEntity.has(key)) pkColsByEntity.set(key, []);
    pkColsByEntity.get(key)!.push(r.column_name!);
  }

  // Bug fix (system-schema leakage / privilege / RLS): has_table_privilege
  // and pg_policies are plain functions/catalog views, not subject to the
  // information_schema constraint-view privilege restriction the PK query
  // above works around — safe to query directly for a SELECT-only role.
  // rls_blocks_read is true only when the role has SELECT, RLS is ON, and
  // no policy applicable to this role (or a role it's a member of) or
  // PUBLIC covers it — i.e. a SELECT would silently return 0 rows rather
  // than error, which is worth a UI warning distinct from "no access at
  // all" (can_select=false already covers that case). See rlsSql.ts for
  // why this needs pg_has_role, not literal current_user identity.
  const privResult = await pool.query(buildIntrospectPrivilegeSql(), [HARD_EXCLUDED_SCHEMAS]);
  const privByEntity = new Map<string, { canRead: boolean; canWrite: boolean; rlsBlocksRead: boolean; rlsFixSql: string | null }>();
  for (const r of privResult.rows as Array<{ table_schema: string; table_name: string; can_select: boolean; can_insert: boolean; rls_blocks_read: boolean; rls_fix_sql: string | null }>) {
    privByEntity.set(`${r.table_schema}.${r.table_name}`, {
      canRead: r.can_select,
      canWrite: r.can_insert,
      rlsBlocksRead: r.rls_blocks_read,
      rlsFixSql: r.rls_fix_sql,
    });
  }

  const byEntity = new Map<string, { namespace: string; name: string; fields: { name: string; type: string }[] }>();
  for (const r of result.rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, { namespace: r.table_schema!, name: r.table_name!, fields: [] });
    }
    byEntity.get(key)!.fields.push({ name: r.column_name!, type: r.data_type! });
  }
  // Single-column PK only — composite PKs report null (same as no PK
  // found), since keyset pagination needs one orderable value.
  return {
    entities: [...byEntity.entries()].map(([key, entity]) => {
      const pkCols = pkColsByEntity.get(key) ?? [];
      const priv = privByEntity.get(key);
      return {
        ...entity,
        primaryKey: pkCols.length === 1 ? pkCols[0]! : null,
        // priv is absent for views (privResult only scans relkind='r'
        // tables) — leaving canRead/canWrite/rlsBlocksRead/rlsFixSql
        // undefined for those, i.e. "not restricted", same as mysql/
        // mongo's connectors.
        ...(priv
          ? { canRead: priv.canRead, canWrite: priv.canWrite, rlsBlocksRead: priv.rlsBlocksRead, rlsFixSql: priv.rlsFixSql }
          : {}),
      };
    }),
  };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
  verifyReadRequest("execute", body.credential.connectionId, body.context, body.query);
  if (body.query.kind !== "sql") {
    throw new Error(`connector-supabase only accepts sql queries, got kind: ${body.query.kind}`);
  }
  const pool = await getPool(body.credential, body.config);
  const start = Date.now();
  const result = await executeWithStatementTimeout(
    pool,
    body.query.sql,
    body.query.params,
    body.timeoutMs,
  );
  const rowArr = result.rows as Array<Record<string, unknown>>;
  const truncated = rowArr.length > body.rowCap;
  const capped = truncated ? rowArr.slice(0, body.rowCap) : rowArr;
  const columns = (result.fields ?? []).map((f) => ({
    name: f.name,
    type: mapPostgresColumnType(f.dataTypeID),
  }));
  return {
    columns,
    rows: capped.map((r) => columns.map((c) => r[c.name])),
    meta: {
      executedQuery: body.query.sql,
      connectionId: body.credential.connectionId,
      durationMs: Date.now() - start,
      rowCount: capped.length,
      truncated,
    },
  };
});

/**
 * Phase 6 Block 2 — the write path. Structured input, not SQL text: this
 * builds the parameterized UPSERT itself (writeSql.ts) rather than routing
 * through @nia/guardrails' validateReadOnlySql, which is a hard read-only
 * allowlist and fundamentally can't accept a write. Row cap is
 * env-configurable (WRITE_ROW_CAP, default matches the kickoff spec's
 * 5000) and is a hard reject, not a truncate-and-continue like /execute's
 * rowCap — silently dropping rows a caller asked to persist would look
 * like a successful write that wasn't.
 *
 * Two independent checks before any SQL runs, mirroring the kickoff
 * spec's "worker-side check before dispatch + connector-side re-check":
 *   1. verifyWriteContext — the signed context's HMAC + freshness window.
 *   2. verifyActiveWriteGrant — a fresh service-role lookup of the grant
 *      by id, confirming it's still confirmed+unrevoked and its scope
 *      actually covers this entity's schema (not just trusting the
 *      worker's pre-dispatch check from moments earlier).
 * Request-vs-context entity/column equality is checked first so a stale
 * or mismatched signature can't be reused to authorize a different write
 * than the one it was actually signed for.
 *
 * Phase 11: this endpoint is ALSO how quarantined rows get written, not
 * just destination upserts — deliberately reusing /write rather than
 * adding a new raw-SQL-shaped endpoint. `body.entity` selects which: if it
 * deep-equals `context.entity` this is a normal destination upsert
 * (unchanged); if it deep-equals `context.quarantineEntity` this is a
 * quarantine-row insert (fixed 6-column shape — run_id, dest_table,
 * step_id, function, input_value, source_row — built by
 * buildQuarantineInsertSql, lazily creating the quarantine table first).
 * Any other entity is rejected — the signed context is still what decides
 * which table(s) this call is allowed to touch, exactly like the staging
 * lifecycle in /stage below.
 */
const WRITE_ROW_CAP = Number(process.env.WRITE_ROW_CAP ?? 5000);
const QUARANTINE_COLUMNS = ["run_id", "dest_table", "step_id", "function", "input_value", "source_row"];

app.post("/write", async (req): Promise<WriteResponse> => {
  const body = WriteRequest.parse(req.body);

  if (body.rows.length > WRITE_ROW_CAP) {
    throw new Error(`write request has ${body.rows.length} rows, exceeding the ${WRITE_ROW_CAP}-row cap per call`);
  }
  for (const row of body.rows) {
    if (row.length !== body.columns.length) {
      throw new Error(`row has ${row.length} values, expected ${body.columns.length} (one per column)`);
    }
  }
  for (const key of body.upsertKeys) {
    if (!body.columns.includes(key)) {
      throw new Error(`upsertKey "${key}" is not present in columns`);
    }
  }
  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      runId: body.context.runId,
      entity: body.context.entity,
      grantNamespace: body.context.grantNamespace,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new HttpError(401, "write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new HttpError(403, "no confirmed, unrevoked write grant covers this entity");

  const isQuarantineWrite = body.context.quarantineEntity !== null && entityMatches(body.entity, body.context.quarantineEntity);

  if (isQuarantineWrite) {
    if (body.columns.length !== QUARANTINE_COLUMNS.length) {
      throw new Error(`quarantine write must send exactly ${QUARANTINE_COLUMNS.length} columns (${QUARANTINE_COLUMNS.join(", ")})`);
    }
    const pool = await getWritePool(body.credential, body.config);
    const start = Date.now();
    const client = await pool.connect();
    try {
      const schemaExists = await checkNiaSchemaExists(client);
      const rlsAlreadyEnabled = await checkQuarantineRlsEnabled(client);
      for (const sql of buildCreateQuarantineSql(body.entity, schemaExists, rlsAlreadyEnabled)) await client.query(sql);
      const sql = buildQuarantineInsertSql(body.entity, body.rows.length);
      const result = await client.query({ text: sql, values: body.rows.flat() });
      return { written: result.rowCount ?? 0, durationMs: Date.now() - start };
    } finally {
      client.release();
    }
  }

  if (!entityMatches(body.entity, body.context.entity)) {
    throw new Error("request entity does not match the signed context's entity");
  }
  const requestColumns = new Set(body.columns);
  const contextColumns = new Set(body.context.columns);
  const columnsMatch =
    requestColumns.size === contextColumns.size && [...requestColumns].every((c) => contextColumns.has(c));
  if (!columnsMatch) {
    throw new Error("request columns do not match the signed context's columns");
  }

  const pool = await getWritePool(body.credential, body.config);

  // Phase (JSON write-layer guard): pg's jsonb binding for a plain object/
  // array value is undocumented/unverified for every non-jsonb destination
  // type — only pay for a destination-column-type lookup when the batch
  // actually contains an object/array value; a normal all-scalar write
  // (every write today, and every existing test) never triggers this
  // query. See writeValueCoercion.ts's header comment.
  let rows: unknown[][] = body.rows;
  if (rowsNeedJsonCoercion(body.rows)) {
    const typeResult = await pool.query(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [body.entity.namespace, body.entity.name],
    );
    const jsonColumns = new Set(
      (typeResult.rows as Array<{ column_name: string; data_type: string }>)
        .filter((r) => r.data_type === "json" || r.data_type === "jsonb")
        .map((r) => r.column_name),
    );
    const coerced = coerceJsonWriteValues(body.columns, body.rows, (c) => jsonColumns.has(c));
    if (!coerced.ok) throw new Error(coerced.error);
    rows = coerced.rows;
  }

  const sql = buildUpsertSql(body.entity, body.columns, body.upsertKeys, body.rows.length);
  const start = Date.now();
  const result = await executeWithStatementTimeout(pool, sql, rows.flat(), body.timeoutMs);
  return { written: result.rowCount ?? 0, durationMs: Date.now() - start };
});

/**
 * Phase 11 Block 2A/2B/2E — the staging lifecycle, discriminated by `op`.
 * Every op re-verifies the signed context's HMAC first, then requires
 * request-vs-context deep-equality on runId/entity/stagingEntity/
 * quarantineEntity/mode before touching anything — this IS the "connector
 * refuses to CREATE/DROP/apply against any table the signed context
 * doesn't name" enforcement point (contract.ts's WriteContext doc
 * comment); staging_objects (the Postgres registry row the worker keeps)
 * is a second, independent layer, not this one.
 */
app.post("/stage", async (req): Promise<StageResponse> => {
  const body = StageRequest.parse(req.body);
  const start = Date.now();

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      runId: body.context.runId,
      entity: body.context.entity,
      grantNamespace: body.context.grantNamespace,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new HttpError(401, "write context signature is invalid or expired");

  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }
  if (body.context.runId !== body.runId) {
    throw new Error("signed context runId does not match the request runId");
  }
  if (!entityMatches(body.entity, body.context.entity)) {
    throw new Error("request entity does not match the signed context's entity");
  }
  if (!body.context.stagingEntity || !entityMatches(body.stagingEntity, body.context.stagingEntity)) {
    throw new Error("request stagingEntity does not match the signed context's stagingEntity");
  }
  if (body.context.mode !== body.mode) {
    throw new Error("request mode does not match the signed context's mode");
  }
  const quarantineMatches =
    body.quarantineEntity === null
      ? body.context.quarantineEntity === null
      : body.context.quarantineEntity !== null && entityMatches(body.quarantineEntity, body.context.quarantineEntity);
  if (!quarantineMatches) {
    throw new Error("request quarantineEntity does not match the signed context's quarantineEntity");
  }

  const grantActive = await verifyActiveWriteGrant(body.context.grantId, body.context.connectionId, body.context.grantNamespace);
  if (!grantActive) throw new HttpError(403, "no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);

  if (body.op === "create") {
    const client = await pool.connect();
    try {
      const schemaExists = await checkNiaSchemaExists(client);
      for (const sql of buildCreateStagingSql(body.entity, body.stagingEntity, schemaExists)) await client.query(sql);
      // The apply op unconditionally UPDATEs the quarantine table (to mark
      // this run's pending rows committed) whenever a quarantineEntity is
      // set, even for a chunk/run that never actually quarantines a row —
      // the /write endpoint's quarantine-write branch (the other caller of
      // buildCreateQuarantineSql) only creates it lazily, on first write.
      // Without also creating it here, that UPDATE hits a nonexistent
      // relation, which aborts the surrounding Postgres transaction; the
      // apply handler's `.catch()` swallows the resulting JS rejection, so
      // the subsequent COMMIT silently no-ops (rolls back) instead of
      // erroring — reporting a fake `applied` count while leaving the
      // destination untouched. Idempotent (CREATE TABLE IF NOT EXISTS),
      // same as the staging table above.
      if (body.quarantineEntity) {
        const rlsAlreadyEnabled = await checkQuarantineRlsEnabled(client);
        for (const sql of buildCreateQuarantineSql(body.quarantineEntity, schemaExists, rlsAlreadyEnabled)) await client.query(sql);
      }
    } finally {
      client.release();
    }
    return { op: "create", ok: true, assertionResults: [], durationMs: Date.now() - start };
  }

  if (body.op === "drop") {
    const client = await pool.connect();
    try {
      await client.query(buildDropStagingSql(body.stagingEntity));
      if (body.quarantineEntity) {
        const { sql } = buildQuarantineDeletePendingSql(body.quarantineEntity);
        await client.query({ text: sql, values: [body.runId] }).catch(() => {
          // Quarantine table may not exist yet (no row ever quarantined this run) — nothing to delete.
        });
      }
    } finally {
      client.release();
    }
    return { op: "drop", ok: true, assertionResults: [], durationMs: Date.now() - start };
  }

  // op === "apply": assertions run first, inside the same transaction as
  // the apply DML, so a failure rolls back cleanly with zero destination
  // effect — matching the plan's "leaves destination untouched" bar.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(body.timeoutMs)}`);

    const assertionResults: AssertionResult[] = [];
    for (const spec of body.assertions) {
      if (spec.kind === "maxFailureRate") {
        let quarantineCount = 0;
        if (body.quarantineEntity) {
          const { sql } = buildQuarantineCountSql(body.quarantineEntity);
          const r = await client.query({ text: sql, values: [body.runId] }).catch(() => ({ rows: [{ n: 0 }] }));
          quarantineCount = Number((r.rows[0] as { n: number }).n);
        }
        const stagingR = await client.query(buildStagingCountSql(body.stagingEntity));
        const stagingCount = Number((stagingR.rows[0] as { n: number }).n);
        const denom = quarantineCount + stagingCount;
        const rate = denom === 0 ? 0 : quarantineCount / denom;
        const ok = rate <= spec.maxRate;
        assertionResults.push({
          spec,
          ok,
          detail: ok ? undefined : `failure rate ${(rate * 100).toFixed(1)}% (${quarantineCount}/${denom}) exceeds ${(spec.maxRate * 100).toFixed(1)}% max`,
        });
        continue;
      }
      const q = buildAssertionQuery(spec, body.stagingEntity, body.entity);
      if (!q) continue;
      const r = await client.query(q.sql);
      const outcome = q.evaluate(r.rows[0] as Record<string, unknown>);
      assertionResults.push({ spec, ok: outcome.ok, detail: outcome.detail });
    }

    if (assertionResults.some((a) => !a.ok)) {
      await client.query("ROLLBACK");
      return { op: "apply", ok: false, assertionResults, durationMs: Date.now() - start };
    }

    let applied = 0;
    for (const sql of buildApplyFromStagingSql(body.entity, body.stagingEntity, body.context.columns, body.upsertKeys, body.mode)) {
      const r = await client.query(sql);
      applied = r.rowCount ?? applied;
    }

    // Sequence fix: any applied column that's sequence-backed on dest just
    // had explicit values written into it (OVERRIDING SYSTEM VALUE above),
    // which never advances the sequence on its own — see
    // buildAdvanceSequencesSql's doc comment. Same transaction as the apply
    // above, so this rolls back with everything else if COMMIT never runs.
    await client.query(buildAdvanceSequencesSql(body.entity, body.context.columns));

    let quarantined = 0;
    if (body.quarantineEntity) {
      const { sql } = buildQuarantineCommitSql(body.quarantineEntity);
      const r = await client.query({ text: sql, values: [body.runId] }).catch(() => ({ rowCount: 0 }));
      quarantined = r.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return { op: "apply", ok: true, assertionResults, applied, quarantined, durationMs: Date.now() - start };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {
      // Connection may already be unusable — nothing more to do.
    });
    throw err;
  } finally {
    client.release();
  }
});

/**
 * Phase 11 Block 2D — preflight. Read-only, signed with the lighter
 * ReadContext (see verifyReadRequest above) rather than a full
 * WriteContext — checks the credential's role can actually do what staged
 * writes will need: create/drop in the `nia` staging schema, and write to
 * the destination entity's schema. Each failure names the exact grant SQL
 * an operator can run.
 */
app.post("/preflight", async (req): Promise<PreflightResponse> => {
  const body = PreflightRequest.parse(req.body);
  verifyReadRequest("preflight", body.credential.connectionId, body.context);
  const pool = await getWritePool(body.credential, body.config);
  const checks: PreflightResponse["checks"] = [];

  // Bug fix: Postgres checks the CREATE privilege *before* evaluating
  // `IF NOT EXISTS`, so `CREATE SCHEMA IF NOT EXISTS "nia"` still fails
  // with "permission denied for database" even when "nia" already exists,
  // for a role that (by design — see docs/decisions.md's "Staging/
  // quarantine writes in nia..." entry) only ever has schema-scoped
  // `CREATE ON SCHEMA "nia"`, never database-level CREATE. The admin-run
  // grant DDL (writeGrantStatement.ts) is what creates "nia" — this check
  // must only ever query for its existence, never attempt to create it
  // itself. Same pg_namespace-first pattern as /create-entity's schemaCheck
  // below, for the destination schema.
  let niaSchemaExists = false;
  try {
    const r = await pool.query(`SELECT 1 FROM pg_namespace WHERE nspname = 'nia'`);
    niaSchemaExists = (r.rowCount ?? 0) > 0;
    checks.push({
      name: "create-schema-nia",
      ok: niaSchemaExists,
      message: niaSchemaExists ? undefined : `schema "nia" does not exist yet — the admin-run grant DDL creates it, this role never should`,
      grantSql: niaSchemaExists ? undefined : `CREATE SCHEMA IF NOT EXISTS "nia"; GRANT USAGE, CREATE ON SCHEMA "nia" TO <role>;`,
    });
  } catch (e) {
    checks.push({
      name: "create-schema-nia",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
    });
  }

  const probeTable = `"nia"."__nia_preflight_probe"`;
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${probeTable} (id int)`);
    await pool.query(`DROP TABLE IF EXISTS ${probeTable}`);
    checks.push({ name: "create-drop-staging-table", ok: true });
  } catch (e) {
    checks.push({
      name: "create-drop-staging-table",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: `GRANT CREATE ON SCHEMA "nia" TO <role>;`,
    });
  }

  const destSchema = body.entity.namespace.replace(/"/g, '""');
  try {
    await pool.query(`SELECT has_schema_privilege(current_user, '${destSchema}', 'USAGE')`);
    const r = await pool.query(
      `SELECT has_table_privilege(current_user, format('%I.%I', $1::text, $2::text), 'INSERT') AS ok`,
      [body.entity.namespace, body.entity.name],
    );
    const ok = Boolean((r.rows[0] as { ok: boolean } | undefined)?.ok);
    checks.push({
      name: "write-destination",
      ok,
      message: ok ? undefined : `role lacks INSERT on "${body.entity.namespace}"."${body.entity.name}"`,
      grantSql: ok ? undefined : `GRANT INSERT, UPDATE, DELETE ON "${body.entity.namespace}"."${body.entity.name}" TO <role>;`,
    });
  } catch (e) {
    checks.push({
      name: "write-destination",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: `GRANT INSERT, UPDATE, DELETE ON "${body.entity.namespace}"."${body.entity.name}" TO <role>;`,
    });
  }

  // Sequence fix — advancing a sequence-backed destination column's
  // sequence after writing explicit ids (buildAdvanceSequencesSql) reads
  // the sequence's current value and calls setval() on it, which need
  // SELECT and UPDATE on the sequence itself — separate privileges from
  // the INSERT/UPDATE/DELETE write-destination checks above. Scoped to
  // the whole entity (every sequence-backed column on the table), same as
  // write-destination's own scope, not just columns this particular run
  // happens to map. Zero sequence-backed columns is a trivial pass, same
  // "nothing to guard" posture as the checks above.
  try {
    const r = await pool.query(
      `SELECT pg_get_serial_sequence(format('%I.%I', $1::text, $2::text), a.attname) AS seq
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped`,
      [body.entity.namespace, body.entity.name],
    );
    const seqs = (r.rows as Array<{ seq: string | null }>).map((row) => row.seq).filter((s): s is string => s !== null);
    const missing: string[] = [];
    for (const seq of seqs) {
      const priv = await pool.query(
        `SELECT has_sequence_privilege(current_user, $1::regclass, 'SELECT') AS can_select, has_sequence_privilege(current_user, $1::regclass, 'UPDATE') AS can_update`,
        [seq],
      );
      const row = priv.rows[0] as { can_select: boolean; can_update: boolean };
      if (!row.can_select || !row.can_update) missing.push(seq);
    }
    const ok = missing.length === 0;
    checks.push({
      name: "sequence-privileges",
      ok,
      message: ok
        ? undefined
        : `role lacks SELECT+UPDATE on sequence(s) ${missing.join(", ")} (needed to advance them after writing explicit ids)`,
      grantSql: ok ? undefined : missing.map((s) => `GRANT USAGE, SELECT, UPDATE ON SEQUENCE ${s} TO <role>;`).join(" "),
    });
  } catch (e) {
    checks.push({
      name: "sequence-privileges",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
    });
  }

  // Phase 13 addition — the `nia` schema (staging + nia_quarantine) must
  // never be reachable through PostgREST's anon/authenticated roles, only
  // through this connector's own write-role credential. `anon`/
  // `authenticated` only exist on a real Supabase project (a plain
  // Postgres sandbox has neither) — 0 matching rows means nothing to
  // guard, not a failure.
  try {
    const r = await pool.query(
      `SELECT rolname, has_schema_privilege(rolname, 'nia', 'USAGE') AS has_usage
       FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
    );
    const offenders = (r.rows as Array<{ rolname: string; has_usage: boolean }>).filter((row) => row.has_usage);
    const ok = offenders.length === 0;
    checks.push({
      name: "nia-schema-no-anon-authenticated-usage",
      ok,
      message: ok
        ? undefined
        : `role(s) ${offenders.map((o) => o.rolname).join(", ")} have USAGE on schema "nia" — PostgREST clients must never reach staging/quarantine tables`,
      grantSql: ok ? undefined : offenders.map((o) => `REVOKE USAGE ON SCHEMA "nia" FROM ${o.rolname};`).join(" "),
    });
  } catch (e) {
    checks.push({
      name: "nia-schema-no-anon-authenticated-usage",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
    });
  }

  // Phase 13 addition — every existing table in `nia` (staging + fixed
  // nia_quarantine sink) must have row-level security enabled, same bar as
  // buildCreateStagingSql/buildCreateQuarantineSql's own ALTER TABLE. A
  // fresh/empty `nia` schema (no tables yet) trivially passes — nothing to
  // guard until a staged run actually creates one.
  try {
    const r = await pool.query(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'nia' AND c.relkind = 'r'`,
    );
    const withoutRls = (r.rows as Array<{ relname: string; relrowsecurity: boolean }>).filter((row) => !row.relrowsecurity);
    const ok = withoutRls.length === 0;
    checks.push({
      name: "nia-schema-rls-enabled",
      ok,
      message: ok
        ? undefined
        : `table(s) ${withoutRls.map((t) => t.relname).join(", ")} in schema "nia" do not have row-level security enabled`,
      grantSql: ok
        ? undefined
        : withoutRls.map((t) => `ALTER TABLE "nia"."${t.relname}" ENABLE ROW LEVEL SECURITY;`).join(" "),
    });
  } catch (e) {
    checks.push({
      name: "nia-schema-rls-enabled",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
    });
  }

  // Bug fix: `nia.nia_quarantine` is one fixed table shared by every write
  // grant on the same underlying database (stagingRegistry.ts's
  // deriveQuarantineEntity), owned by whichever role created it. A second
  // grant's role that only got scoped DML privileges (never ownership —
  // see writeGrantStatement.ts/docs/decisions.md) would otherwise only find
  // out it can't use the table mid-run, once a staged write actually tries
  // to insert/update it. Detect the mismatch here instead, with the exact
  // fix an owner/admin needs to run. A missing table is not a failure —
  // nothing to guard until some run's first quarantine write creates it.
  try {
    const r = await pool.query(
      `SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'nia' AND c.relname = 'nia_quarantine'`,
    );
    const tableExists = (r.rowCount ?? 0) > 0;
    if (!tableExists) {
      checks.push({ name: "quarantine-table-ownership", ok: true });
    } else {
      const owner = (r.rows[0] as { owner: string }).owner;
      const privs = await Promise.all(
        ["select", "insert", "update", "delete"].map(async (priv) => {
          const pr = await pool.query(`SELECT has_table_privilege(current_user, 'nia.nia_quarantine', $1) AS ok`, [priv]);
          return { priv, ok: Boolean((pr.rows[0] as { ok: boolean } | undefined)?.ok) };
        }),
      );
      const missing = privs.filter((p) => !p.ok).map((p) => p.priv.toUpperCase());
      const ok = missing.length === 0;
      checks.push({
        name: "quarantine-table-ownership",
        ok,
        message: ok
          ? undefined
          : `table "nia"."nia_quarantine" already exists, owned by role "${owner}" (not this role), and this role lacks ${missing.join(", ")} on it`,
        // GRANT on a table requires being its owner (or holding GRANT OPTION).
        // An admin/owner credential normally isn't a member of "${owner}"
        // (the role that happened to create this table first), so it must
        // assume that role first — drop the GRANT/SET ROLE/RESET ROLE lines
        // below only if the admin credential already *is* "${owner}".
        grantSql: ok
          ? undefined
          : [
              `-- run as an admin/owner credential`,
              `GRANT "${owner}" TO CURRENT_USER; -- skip this + the next 2 lines if you're already "${owner}"`,
              `SET ROLE "${owner}";`,
              `GRANT ${missing.join(", ")} ON "nia"."nia_quarantine" TO <role>;`,
              `RESET ROLE;`,
            ].join("\n"),
      });
    }
  } catch (e) {
    checks.push({
      name: "quarantine-table-ownership",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
});

/**
 * Schema layer, Part 4 — destination creation. Signed the same way as
 * /write/​/stage: verifies the WriteContext HMAC, then requires the
 * request's entity/columns to deep-equal the signed context's before
 * anything runs, then re-checks the write grant. `kind` must be "table"
 * (this connector never creates a "collection"). Idempotent
 * (`IF NOT EXISTS` throughout, from writeSql.ts's buildCreateTableSql) —
 * the caller (runEtl.ts, via destinationContract.ts) has already confirmed
 * via /introspect that the entity doesn't exist, but this stays safe
 * against a redelivered first-chunk job racing a concurrent create.
 * RLS is enabled on the new table only when this project actually has
 * PostgREST-facing anon/authenticated roles (Part 4's "If anon/
 * authenticated roles exist, enable RLS on created tables" bullet) — same
 * existence check preflight already runs for its own anon/authenticated
 * guard below.
 */
app.post("/create-entity", async (req): Promise<CreateEntityResponse> => {
  const body = CreateEntityRequest.parse(req.body);
  const start = Date.now();

  if (body.kind !== "table") {
    throw new Error(`connector-supabase only creates SQL tables, got kind: ${body.kind}`);
  }
  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }
  if (!entityMatches(body.entity, body.context.entity)) {
    throw new Error("request entity does not match the signed context's entity");
  }
  const requestColumns = new Set(body.columns.map((c) => c.name));
  const contextColumns = new Set(body.context.columns);
  const columnsMatch =
    requestColumns.size === contextColumns.size && [...requestColumns].every((c) => contextColumns.has(c));
  if (!columnsMatch) {
    throw new Error("request columns do not match the signed context's columns");
  }
  for (const key of body.keys) {
    if (!requestColumns.has(key)) {
      throw new Error(`key column "${key}" is not present in columns`);
    }
  }

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      runId: body.context.runId,
      entity: body.context.entity,
      grantNamespace: body.context.grantNamespace,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new HttpError(401, "write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new HttpError(403, "no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const client = await pool.connect();
  try {
    const schemaCheck = await client.query(`SELECT 1 FROM pg_namespace WHERE nspname = $1`, [body.entity.namespace]);
    const schemaExists = (schemaCheck.rowCount ?? 0) > 0;
    for (const sql of buildCreateTableSql(body.entity, body.columns, body.keys, schemaExists)) await client.query(sql);

    const roleCheck = await client.query(
      `SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')`,
    );
    if ((roleCheck.rowCount ?? 0) > 0) {
      await client.query(buildEnableRlsSql(body.entity));
    }
  } finally {
    client.release();
  }

  return { created: true, durationMs: Date.now() - start };
});

/**
 * Orphaned-destination-table lifecycle fix — the drop-side counterpart to
 * /create-entity, same signed-context verification order. Only ever
 * dispatched by runEtl.ts's failStaged against an entity the worker's own
 * stagingRegistry recorded THIS run as having created — never a general
 * "drop any table" capability. `IF EXISTS` (buildDropTableSql): idempotent
 * against a redelivered failStaged call finding the table already gone.
 */
app.post("/drop-entity", async (req): Promise<DropEntityResponse> => {
  const body = DropEntityRequest.parse(req.body);
  const start = Date.now();

  if (body.kind !== "table") {
    throw new Error(`connector-supabase only drops SQL tables, got kind: ${body.kind}`);
  }
  if (body.context.connectionId !== body.credential.connectionId) {
    throw new Error("signed context connectionId does not match the request credential");
  }
  if (!entityMatches(body.entity, body.context.entity)) {
    throw new Error("request entity does not match the signed context's entity");
  }

  const secret = process.env.WRITE_DISPATCH_SIGNING_SECRET;
  if (!secret) throw new Error("WRITE_DISPATCH_SIGNING_SECRET is not configured");
  const signatureValid = verifyWriteContext(
    {
      connectionId: body.context.connectionId,
      grantId: body.context.grantId,
      runId: body.context.runId,
      entity: body.context.entity,
      grantNamespace: body.context.grantNamespace,
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new HttpError(401, "write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new HttpError(403, "no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const client = await pool.connect();
  try {
    await client.query(buildDropTableSql(body.entity));
  } finally {
    client.release();
  }

  return { dropped: true, durationMs: Date.now() - start };
});

app.post("/invalidate", async (req) => {
  const { connectionId, context } = InvalidateRequest.parse(req.body);
  verifyReadRequest("invalidate", connectionId, context);
  return { evicted: await evict(connectionId) };
});

// Guarded so importing this module (e.g. from an integration test that
// drives routes via app.inject()) doesn't also try to bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4030);
  checkSupabaseReachable()
    .then(() => app.listen({ port, host: "0.0.0.0" }))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });

  // Graceful shutdown: Fastify's close() stops accepting new connections
  // and waits for in-flight requests to finish before resolving.
  const shutdown = () => {
    app.log.info("shutting down…");
    app
      .close()
      .then(() => process.exit(0))
      .catch((err) => {
        app.log.error(err);
        process.exit(1);
      });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { app };
