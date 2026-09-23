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
} from "@nia/schemas";
import { getPool, getWritePool, evict, poolCount, verifyActiveWriteGrant, checkVaultReachable } from "./pool-manager.js";
import { verifyWriteContext } from "./writeSignature.js";
import { buildUpsertSql, buildCreateTableSql, buildDropTableSql } from "./writeSql.js";
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
 * connector-mysql — one shared service per tool type on the internal Docker
 * network. Uniform contract: /test /introspect /execute /invalidate /health,
 * plus /write (Phase 6 Block 5 — this connector's etl_sink capability,
 * mirroring connector-supabase's write path exactly, just MySQL-dialect),
 * plus /stage and /preflight (Phase 11 — staging lifecycle, MySQL-dialect
 * mirror of connector-supabase's /stage and /preflight).
 *
 * The worker sends dialect-native, guardrail-approved queries. This service's
 * jobs are pooling, execution, and normalization to the tabular shape.
 */

const app = Fastify({ logger: true });

app.get("/health", async () => ({
  status: "ok" as const,
  service: "connector-mysql",
  pools: poolCount(),
  routes: ["test", "introspect", "execute", "invalidate", "write", "stage", "preflight", "create-entity", "drop-entity"],
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
  // information_schema.columns is implemented as a view with uppercase
  // column definitions — MySQL returns TABLE_SCHEMA/TABLE_NAME/etc.
  // regardless of the case used in this query text, so explicit lowercase
  // aliases are required (not just style) to make the destructuring below
  // actually populate instead of silently reading `undefined`.
  //
  // column_key is native to information_schema.columns ('PRI' marks a
  // primary-key column) — no join needed here, unlike Postgres (see
  // connector-supabase's /introspect). Phase 6 Block 3.5: this is what
  // lets IntrospectResponse report a verified-unique key per entity for
  // the ETL runner's keyset pagination.
  const [rows] = await pool.query(
    `SELECT table_schema AS table_schema, table_name AS table_name,
            column_name AS column_name, data_type AS data_type,
            column_key AS column_key
     FROM information_schema.columns
     WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys')
     ORDER BY table_schema, table_name, ordinal_position`,
  );
  const byEntity = new Map<
    string,
    { namespace: string; name: string; fields: { name: string; type: string }[]; primaryKeyCols: string[] }
  >();
  for (const r of rows as Array<Record<string, string>>) {
    const key = `${r.table_schema}.${r.table_name}`;
    if (!byEntity.has(key)) {
      byEntity.set(key, { namespace: r.table_schema!, name: r.table_name!, fields: [], primaryKeyCols: [] });
    }
    const entity = byEntity.get(key)!;
    entity.fields.push({ name: r.column_name!, type: r.data_type! });
    if (r.column_key === "PRI") entity.primaryKeyCols.push(r.column_name!);
  }
  // Single-column PK only — a composite PK can't drive keyset pagination
  // (WHERE key > cursor needs one orderable value), so it's reported the
  // same as "no key found" (null) rather than picking one column.
  return {
    entities: [...byEntity.values()].map(({ primaryKeyCols, ...entity }) => ({
      ...entity,
      primaryKey: primaryKeyCols.length === 1 ? primaryKeyCols[0]! : null,
    })),
  };
});

app.post("/execute", async (req): Promise<TabularResult> => {
  const body = ExecuteRequest.parse(req.body);
  if (body.query.kind !== "sql") {
    throw new Error(`connector-mysql only accepts sql queries, got kind: ${body.query.kind}`);
  }
  const pool = await getPool(body.credential, body.config);
  const start = Date.now();
  const [rows, fields] = await pool.query({
    sql: body.query.sql,
    values: body.query.params,
    timeout: body.timeoutMs,
  });
  const rowArr = rows as Array<Record<string, unknown>>;
  const truncated = rowArr.length > body.rowCap;
  const capped = truncated ? rowArr.slice(0, body.rowCap) : rowArr;
  const columns = (fields ?? []).map((f) => ({
    name: f.name,
    type: "unknown" as const, // TODO: map mysql2 field types → ColumnType
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
 * Phase 6 Block 5 — write path. Mirrors connector-supabase's /write exactly
 * (same validation order, same two independent checks before any SQL runs:
 * verifyWriteContext's HMAC+freshness, then a fresh verifyActiveWriteGrant
 * lookup) — see that file's header comment for the full rationale. Only
 * difference is dialect: buildUpsertSql (writeSql.ts) emits MySQL's
 * `ON DUPLICATE KEY UPDATE` instead of Postgres's `ON CONFLICT`, and this
 * runs the statement via pool.query directly (mysql2's client-side
 * `timeout` option) rather than a executeWithStatementTimeout wrapper —
 * connector-mysql has never had one; /execute above uses the same
 * pool.query({sql, values, timeout}) shape.
 *
 * Phase 11: this endpoint is ALSO how quarantined rows get written — see
 * connector-supabase's /write header comment for the full rationale
 * (deliberately reused rather than adding a new raw-SQL-shaped endpoint).
 * `body.entity` selects which: matches `context.entity` → normal
 * destination upsert (unchanged); matches `context.quarantineEntity` →
 * quarantine-row insert (fixed 6-column shape, lazily creating the
 * quarantine table first).
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
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const isQuarantineWrite =
    body.context.quarantineEntity !== null && entityMatches(body.entity, body.context.quarantineEntity);

  if (isQuarantineWrite) {
    if (body.columns.length !== QUARANTINE_COLUMNS.length) {
      throw new Error(`quarantine write must send exactly ${QUARANTINE_COLUMNS.length} columns (${QUARANTINE_COLUMNS.join(", ")})`);
    }
    const pool = await getWritePool(body.credential, body.config);
    const start = Date.now();
    const conn = await pool.getConnection();
    try {
      for (const sql of buildCreateQuarantineSql(body.entity)) await conn.query(sql);
      const sql = buildQuarantineInsertSql(body.entity, body.rows.length);
      const [result] = await conn.query(sql, body.rows.flat());
      const written = (result as { affectedRows?: number }).affectedRows ?? 0;
      return { written, durationMs: Date.now() - start };
    } finally {
      conn.release();
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

  // Phase (JSON write-layer guard): mysql2 stringifies a plain object/array
  // value via `.toString()` (producing the literal text "[object Object]")
  // rather than JSON-encoding it — only pay for a destination-column-type
  // lookup when the batch actually contains an object/array value; a normal
  // all-scalar write (every write today, and every existing test) never
  // triggers this query. See writeValueCoercion.ts's header comment.
  let rows: unknown[][] = body.rows;
  if (rowsNeedJsonCoercion(body.rows)) {
    const [typeRows] = await pool.query(
      `SELECT column_name AS column_name, data_type AS data_type
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?`,
      [body.entity.namespace, body.entity.name],
    );
    const jsonColumns = new Set(
      (typeRows as Array<{ column_name: string; data_type: string }>)
        .filter((r) => r.data_type === "json")
        .map((r) => r.column_name),
    );
    const coerced = coerceJsonWriteValues(body.columns, body.rows, (c) => jsonColumns.has(c));
    if (!coerced.ok) throw new Error(coerced.error);
    rows = coerced.rows;
  }

  const sql = buildUpsertSql(body.entity, body.columns, body.upsertKeys, body.rows.length);
  const start = Date.now();
  const [result] = await pool.query({
    sql,
    values: rows.flat(),
    timeout: body.timeoutMs,
  });
  const written = (result as { affectedRows?: number }).affectedRows ?? 0;
  return { written, durationMs: Date.now() - start };
});

/**
 * Phase 11 Block 2A/2B/2E — the staging lifecycle, discriminated by `op`.
 * MySQL-dialect mirror of connector-supabase's /stage — same enforcement
 * order (HMAC first, then request-vs-context deep-equality on
 * runId/entity/stagingEntity/quarantineEntity/mode before touching
 * anything). Transactions use mysql2's connection.beginTransaction/commit/
 * rollback (no `SET LOCAL statement_timeout` equivalent in MySQL — the
 * client-side `timeout` option connector-mysql already uses elsewhere
 * isn't available mid-transaction on a dedicated connection, so apply
 * relies on the destination's own query timeouts).
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

  const grantActive = await verifyActiveWriteGrant(body.context.grantId, body.context.connectionId, body.context.grantNamespace);
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);

  if (body.op === "create") {
    const conn = await pool.getConnection();
    try {
      for (const sql of buildCreateStagingSql(body.entity, body.stagingEntity)) await conn.query(sql);
    } finally {
      conn.release();
    }
    return { op: "create", ok: true, assertionResults: [], durationMs: Date.now() - start };
  }

  if (body.op === "drop") {
    const conn = await pool.getConnection();
    try {
      await conn.query(buildDropStagingSql(body.stagingEntity));
      if (body.quarantineEntity) {
        const { sql } = buildQuarantineDeletePendingSql(body.quarantineEntity);
        await conn.query(sql, [body.runId]).catch(() => {
          // Quarantine table may not exist yet (no row ever quarantined this run) — nothing to delete.
        });
      }
    } finally {
      conn.release();
    }
    return { op: "drop", ok: true, assertionResults: [], durationMs: Date.now() - start };
  }

  // op === "apply": assertions run first, inside the same transaction as
  // the apply DML, so a failure rolls back cleanly with zero destination
  // effect — matching the plan's "leaves destination untouched" bar.
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const assertionResults: AssertionResult[] = [];
    for (const spec of body.assertions) {
      if (spec.kind === "maxFailureRate") {
        let quarantineCount = 0;
        if (body.quarantineEntity) {
          const { sql } = buildQuarantineCountSql(body.quarantineEntity);
          const quarantineResult = await conn.query(sql, [body.runId]).catch(() => null);
          const rows = quarantineResult ? (quarantineResult[0] as Array<{ n: number }>) : [{ n: 0 }];
          quarantineCount = Number(rows[0]?.n ?? 0);
        }
        const [stagingRows] = await conn.query(buildStagingCountSql(body.stagingEntity));
        const stagingCount = Number((stagingRows as Array<{ n: number }>)[0]?.n ?? 0);
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
      const [rows] = await conn.query(q.sql);
      const outcome = q.evaluate(((rows as Array<Record<string, unknown>>)[0] ?? {}) as Record<string, unknown>);
      assertionResults.push({ spec, ok: outcome.ok, detail: outcome.detail });
    }

    if (assertionResults.some((a) => !a.ok)) {
      await conn.rollback();
      return { op: "apply", ok: false, assertionResults, durationMs: Date.now() - start };
    }

    let applied = 0;
    for (const sql of buildApplyFromStagingSql(body.entity, body.stagingEntity, body.context.columns, body.upsertKeys, body.mode)) {
      const [result] = await conn.query(sql);
      applied = (result as { affectedRows?: number }).affectedRows ?? applied;
    }

    let quarantined = 0;
    if (body.quarantineEntity) {
      const { sql } = buildQuarantineCommitSql(body.quarantineEntity);
      const commitResult = await conn.query(sql, [body.runId]).catch(() => null);
      quarantined = commitResult ? ((commitResult[0] as { affectedRows?: number }).affectedRows ?? 0) : 0;
    }

    await conn.commit();
    return { op: "apply", ok: true, assertionResults, applied, quarantined, durationMs: Date.now() - start };
  } catch (err) {
    await conn.rollback().catch(() => {
      // Connection may already be unusable — nothing more to do.
    });
    throw err;
  } finally {
    conn.release();
  }
});

/**
 * Phase 11 Block 2D — preflight. Unsigned and read-only, checks the
 * credential's role can actually do what staged writes will need: create/
 * drop in the `nia` staging database, and write to the destination
 * entity's database. MySQL has no has_table_privilege() builtin (unlike
 * postgres) — write-destination is checked via information_schema.
 * table_privileges, matching the connector's own CURRENT_USER() against
 * the 'user'@'host' GRANTEE format that view reports.
 */
app.post("/preflight", async (req): Promise<PreflightResponse> => {
  const body = PreflightRequest.parse(req.body);
  const pool = await getWritePool(body.credential, body.config);
  const checks: PreflightResponse["checks"] = [];

  try {
    await pool.query("CREATE DATABASE IF NOT EXISTS `nia`");
    checks.push({ name: "create-schema-nia", ok: true });
  } catch (e) {
    checks.push({
      name: "create-schema-nia",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: "GRANT CREATE ON *.* TO '<user>'@'%';",
    });
  }

  const probeTable = "`nia`.`__nia_preflight_probe`";
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${probeTable} (id int)`);
    await pool.query(`DROP TABLE IF EXISTS ${probeTable}`);
    checks.push({ name: "create-drop-staging-table", ok: true });
  } catch (e) {
    checks.push({
      name: "create-drop-staging-table",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: "GRANT CREATE, DROP ON `nia`.* TO '<user>'@'%';",
    });
  }

  try {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS n FROM information_schema.table_privileges
       WHERE table_schema = ? AND table_name = ? AND privilege_type = 'INSERT'
         AND grantee = CONCAT("'", SUBSTRING_INDEX(CURRENT_USER(),'@',1), "'@'", SUBSTRING_INDEX(CURRENT_USER(),'@',-1), "'")`,
      [body.entity.namespace, body.entity.name],
    );
    const n = Number((rows as Array<{ n: number }>)[0]?.n ?? 0);
    const ok = n > 0;
    checks.push({
      name: "write-destination",
      ok,
      message: ok ? undefined : `role lacks INSERT on \`${body.entity.namespace}\`.\`${body.entity.name}\``,
      grantSql: ok ? undefined : `GRANT INSERT, UPDATE, DELETE ON \`${body.entity.namespace}\`.\`${body.entity.name}\` TO '<user>'@'%';`,
    });
  } catch (e) {
    checks.push({
      name: "write-destination",
      ok: false,
      message: e instanceof Error ? e.message : "unknown error",
      grantSql: `GRANT INSERT, UPDATE, DELETE ON \`${body.entity.namespace}\`.\`${body.entity.name}\` TO '<user>'@'%';`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
});

/**
 * Schema layer, Part 4 — destination creation. MySQL-dialect mirror of
 * connector-supabase's /create-entity (same signed-context verification
 * order); `kind` must be "table". No RLS concept in MySQL, so no
 * equivalent of connector-supabase's anon/authenticated-role check here.
 */
app.post("/create-entity", async (req): Promise<CreateEntityResponse> => {
  const body = CreateEntityRequest.parse(req.body);
  const start = Date.now();

  if (body.kind !== "table") {
    throw new Error(`connector-mysql only creates SQL tables, got kind: ${body.kind}`);
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
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const conn = await pool.getConnection();
  try {
    for (const sql of buildCreateTableSql(body.entity, body.columns, body.keys)) await conn.query(sql);
  } finally {
    conn.release();
  }

  return { created: true, durationMs: Date.now() - start };
});

/**
 * Orphaned-destination-table lifecycle fix — MySQL-dialect mirror of
 * connector-supabase's /drop-entity. Only ever dispatched by runEtl.ts's
 * failStaged against an entity the worker's own stagingRegistry recorded
 * THIS run as having created.
 */
app.post("/drop-entity", async (req): Promise<DropEntityResponse> => {
  const body = DropEntityRequest.parse(req.body);
  const start = Date.now();

  if (body.kind !== "table") {
    throw new Error(`connector-mysql only drops SQL tables, got kind: ${body.kind}`);
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
  if (!signatureValid) throw new Error("write context signature is invalid or expired");

  const grantActive = await verifyActiveWriteGrant(
    body.context.grantId,
    body.context.connectionId,
    body.context.grantNamespace,
  );
  if (!grantActive) throw new Error("no confirmed, unrevoked write grant covers this entity");

  const pool = await getWritePool(body.credential, body.config);
  const conn = await pool.getConnection();
  try {
    await conn.query(buildDropTableSql(body.entity));
  } finally {
    conn.release();
  }

  return { dropped: true, durationMs: Date.now() - start };
});

app.post("/invalidate", async (req) => {
  const { connectionId } = InvalidateRequest.parse(req.body);
  return { evicted: await evict(connectionId) };
});

// Guarded so importing this module (e.g. from an integration test that
// drives routes via app.inject()) doesn't also try to bind a real socket.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 4010);
  checkVaultReachable()
    .then(() => app.listen({ port, host: "0.0.0.0" }))
    .catch((err) => {
      app.log.error(err);
      process.exit(1);
    });
}

export { app };
