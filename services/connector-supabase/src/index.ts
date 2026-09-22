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
  rowsNeedJsonCoercion,
  coerceJsonWriteValues,
  type TabularResult,
  type WriteResponse,
  type StageResponse,
  type PreflightResponse,
  type AssertionResult,
  type WriteEntityRef,
  type CreateEntityResponse,
} from "@nia/schemas";
import { getPool, getWritePool, evict, poolCount, verifyActiveWriteGrant } from "./pool-manager.js";
import { mapPostgresColumnType } from "./column-types.js";
import { executeWithStatementTimeout } from "./query.js";
import { verifyWriteContext } from "./writeSignature.js";
import { buildUpsertSql, buildCreateTableSql, buildEnableRlsSql } from "./writeSql.js";
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
} from "./stagingSql.js";

function entityMatches(a: WriteEntityRef, b: WriteEntityRef): boolean {
  return a.namespace === b.namespace && a.name === b.name;
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

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-supabase",
  pools: poolCount(),
  routes: ["test", "introspect", "execute", "invalidate", "write", "stage", "preflight", "create-entity"],
}));

app.post("/test", async (req) => {
  const { credential, config } = TestRequest.parse(req.body);
  const start = Date.now();
  try {
    const pool = await getPool(credential, config);
    await pool.query("SELECT 1");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "unknown" };
  }
});

app.post("/introspect", async (req) => {
  const { credential, config } = IntrospectRequest.parse(req.body);
  const pool = await getPool(credential, config);
  const result = await pool.query(
    `SELECT table_schema, table_name, column_name, data_type
     FROM information_schema.columns
     WHERE table_schema NOT IN ('information_schema','pg_catalog','pg_toast')
     ORDER BY table_schema, table_name, ordinal_position`,
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
       AND n.nspname NOT IN ('information_schema','pg_catalog','pg_toast')
     ORDER BY n.nspname, c.relname, a.attnum`,
  );
  const pkColsByEntity = new Map<string, string[]>();
  for (const r of pkResult.rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!pkColsByEntity.has(key)) pkColsByEntity.set(key, []);
    pkColsByEntity.get(key)!.push(r.column_name!);
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
      return { ...entity, primaryKey: pkCols.length === 1 ? pkCols[0]! : null };
    }),
  };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
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
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.entity.namespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const isQuarantineWrite = body.context.quarantineEntity !== null && entityMatches(body.entity, body.context.quarantineEntity);

  if (isQuarantineWrite) {
    if (body.columns.length !== QUARANTINE_COLUMNS.length) {
      throw new Error(`quarantine write must send exactly ${QUARANTINE_COLUMNS.length} columns (${QUARANTINE_COLUMNS.join(", ")})`);
    }
    const pool = await getWritePool(body.credential, body.config);
    const start = Date.now();
    const client = await pool.connect();
    try {
      for (const sql of buildCreateQuarantineSql(body.entity)) await client.query(sql);
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
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

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

  const grantActive = await verifyActiveWriteGrant(body.context.grantId, body.context.connectionId, body.entity.namespace);
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);

  if (body.op === "create") {
    const client = await pool.connect();
    try {
      for (const sql of buildCreateStagingSql(body.entity, body.stagingEntity)) await client.query(sql);
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
        for (const sql of buildCreateQuarantineSql(body.quarantineEntity)) await client.query(sql);
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
 * Phase 11 Block 2D — preflight. Unsigned and read-only, checks the
 * credential's role can actually do what staged writes will need: create/
 * drop in the `nia` staging schema, and write to the destination entity's
 * schema. Each failure names the exact grant SQL an operator can run.
 */
app.post("/preflight", async (req): Promise<PreflightResponse> => {
  const body = PreflightRequest.parse(req.body);
  const pool = await getWritePool(body.credential, body.config);
  const checks: PreflightResponse["checks"] = [];

  try {
    await pool.query('CREATE SCHEMA IF NOT EXISTS "nia"');
    checks.push({ name: "create-schema-nia", ok: true });
  } catch (e) {
    checks.push({
      name: "create-schema-nia",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: "GRANT CREATE ON DATABASE current_database() TO <role>;",
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
      columns: body.context.columns,
      mode: body.context.mode,
      stagingEntity: body.context.stagingEntity,
      quarantineEntity: body.context.quarantineEntity,
      issuedAt: body.context.issuedAt,
    },
    body.context.signature,
    secret,
  );
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.entity.namespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const client = await pool.connect();
  try {
    for (const sql of buildCreateTableSql(body.entity, body.columns, body.keys)) await client.query(sql);

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

app.post("/invalidate", async (req) => {
  const { connectionId } = InvalidateRequest.parse(req.body);
  return { evicted: await evict(connectionId) };
});

// Guarded so importing this module (e.g. from an integration test that
// drives routes via app.inject()) doesn't also try to bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4030);
  app.listen({ port, host: "0.0.0.0" }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}

export { app };
