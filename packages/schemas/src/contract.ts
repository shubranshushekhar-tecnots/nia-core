import { z } from "zod";
import { TabularResult } from "./tabular.js";

/**
 * The uniform connector-service contract.
 * Every service (query / action / file family) exposes:
 *   POST /test, POST /introspect, POST /execute, POST /invalidate, GET /health
 * Later (behind write grants + actions): POST /write, POST /invoke.
 *
 * Credentials NEVER appear in these payloads. Services fetch them from
 * Vault themselves via `credentialRef`, keyed by connectionId:credVersion.
 */

export const CredentialRef = z.object({
  connectionId: z.string().uuid(),
  /** Bumped on rotation — also the pool key suffix, so stale pools die naturally. */
  credVersion: z.number().int().nonnegative(),
  /** Vault path/reference the service resolves itself. */
  vaultRef: z.string(),
});
export type CredentialRef = z.infer<typeof CredentialRef>;

/**
 * The connection's non-secret manifest fields (e.g. MySQL's host/port/
 * database) — stored in Postgres, passed through by Express on every
 * dispatch. Shape is connector-specific, so this stays a generic bag; each
 * service narrows it to what its own manifest declares.
 *
 * TODO(security): this schema (or a per-connector-kind extension of it)
 * should require/verify that the resolved DB credential's role is
 * read-only at Connect time (e.g. reject the connection if the DB user
 * has write privileges). Today that's purely an operational convention —
 * nothing here or in CredentialRef enforces or checks it — which means
 * guardrails/sql/validator.ts's "the read-only role is the real boundary"
 * framing is aspirational, not actually enforced. See that file's module
 * header for why this matters concretely (the MySQL `/*! ... *\/` bypass).
 * Not implemented here — this is a config-schema/connect-flow change.
 */
export const ConnectorConfig = z.record(z.string(), z.unknown());
export type ConnectorConfig = z.infer<typeof ConnectorConfig>;

export const TestRequest = z.object({ credential: CredentialRef, config: ConnectorConfig });
export const TestResponse = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  error: z.string().optional(),
});

export const IntrospectRequest = z.object({ credential: CredentialRef, config: ConnectorConfig });
export const IntrospectResponse = z.object({
  /** Schemas/collections → entities → fields, feeding AI-proposed mappings. */
  entities: z.array(
    z.object({
      namespace: z.string(),
      name: z.string(),
      fields: z.array(z.object({ name: z.string(), type: z.string(), degraded: z.boolean().optional() })),
      /**
       * Single-column verified-unique key for this entity, if one exists
       * (SQL: the sole PRIMARY KEY column; null if the table has no PK or a
       * composite one — composite-key keyset pagination isn't supported,
       * so those entities are treated the same as "no key found"). Mongo
       * connectors never populate this — apps/worker/src/lib/etl/
       * queryBuilder.ts always keys Mongo off `_id` instead, which is
       * unconditionally unique. Phase 6 Block 3.5: this is what lets the
       * ETL runner do keyset pagination (WHERE key > cursor) instead of
       * OFFSET, and what backs the "no unique key → hard fail at run
       * start" precondition in runEtl.ts.
       */
      primaryKey: z.string().nullable().default(null),
    }),
  ),
});

/**
 * Structured, connector-kind-discriminated query payload. Each connector
 * family gets its own shape instead of every connector being forced through
 * a single opaque string — e.g. Mongo's pipeline is a real array on the
 * wire, not JSON-stuffed into a string field.
 */
export const SqlQueryPayload = z.object({
  kind: z.literal("sql"),
  /** Dialect-native SQL text, already guardrail-approved by the worker. */
  sql: z.string(),
  params: z.array(z.unknown()).default([]),
});
export const MongoQueryPayload = z.object({
  kind: z.literal("mongo"),
  collection: z.string(),
  /** Aggregation pipeline, already guardrail-approved by the worker. */
  pipeline: z.array(z.record(z.string(), z.unknown())),
});
export const QueryPayload = z.discriminatedUnion("kind", [SqlQueryPayload, MongoQueryPayload]);
export type SqlQueryPayload = z.infer<typeof SqlQueryPayload>;
export type MongoQueryPayload = z.infer<typeof MongoQueryPayload>;
export type QueryPayload = z.infer<typeof QueryPayload>;

export const ExecuteRequest = z.object({
  credential: CredentialRef,
  config: ConnectorConfig,
  query: QueryPayload,
  rowCap: z.number().int().positive().default(1000),
  timeoutMs: z.number().int().positive().default(15000),
});
export const ExecuteResponse = TabularResult;

export const InvalidateRequest = z.object({
  connectionId: z.string().uuid(),
});
export const InvalidateResponse = z.object({ evicted: z.boolean() });

/**
 * Phase 6 Block 2 — the write path. Unlike QueryPayload (worker-composed
 * SQL/pipeline text), a write request is fully structured: the connector
 * service itself builds the parameterized UPSERT from entity/columns/
 * upsertKeys, so these three fields are real SQL *identifiers*, not
 * free text — constrained here (not reusing nodeConfig.ts's looser
 * EntityRef, which also allows the picker's transient "" state) so a
 * malformed identifier is rejected at parse time, before it ever reaches
 * connector-supabase's own allowlist re-check (defense in depth, same
 * two-layers-even-internally posture as the signed context below).
 */
const SqlIdentifier = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be a valid SQL identifier");

export const WriteEntityRef = z.object({
  namespace: SqlIdentifier,
  name: SqlIdentifier,
});
export type WriteEntityRef = z.infer<typeof WriteEntityRef>;

export const WriteMode = z.enum(["upsert", "replace"]);
export type WriteMode = z.infer<typeof WriteMode>;

/**
 * The worker computes this (writeSignature.ts) before dispatch and
 * connector-supabase independently recomputes + verifies it (its own copy
 * of the same helper) before trusting the request — "worker-side check
 * before dispatch + connector-side re-check" from the kickoff spec's Block
 * 2, layer 2 of the write path's three (UI / API / DB-credential-privilege)
 * layers. `issuedAt` (epoch ms) bounds the signature to a short freshness
 * window even though this is internal-network-only traffic. Deliberately
 * NOT a JWT/existing-auth-token reuse — this asserts something a user JWT
 * doesn't ("the worker re-checked this exact entity+columns against a
 * confirmed grant just now"), not identity.
 *
 * Phase 11: `runId`/`mode`/`stagingEntity`/`quarantineEntity` extend the
 * signed assertion to cover the staging lifecycle (createStaging/
 * applyStaging/dropStaging — StageRequest below), not just row upserts. A
 * /stage request is only ever honored by a connector when its
 * stagingEntity/quarantineEntity/mode/runId deep-equal the SAME fields
 * inside this signed context — i.e. staging DDL follows the exact same
 * "structured request, signed context, connector re-checks before
 * mutating" model as the row-write path, never a new raw-SQL surface.
 * `stagingEntity`/`quarantineEntity` are null for a plain row-upsert
 * WriteRequest context (today's only use before Phase 11).
 */
export const WriteContext = z.object({
  connectionId: z.string().uuid(),
  grantId: z.string().uuid(),
  runId: z.string().uuid().nullable().default(null),
  entity: WriteEntityRef,
  columns: z.array(SqlIdentifier).min(1),
  mode: WriteMode.default("upsert"),
  stagingEntity: WriteEntityRef.nullable().default(null),
  quarantineEntity: WriteEntityRef.nullable().default(null),
  issuedAt: z.number().int(),
  signature: z.string(),
});
export type WriteContext = z.infer<typeof WriteContext>;

export const WriteRequest = z.object({
  credential: CredentialRef,
  config: ConnectorConfig,
  entity: WriteEntityRef,
  columns: z.array(SqlIdentifier).min(1),
  /** Positional per row, same convention as TabularResult.rows — each inner array's values line up with `columns` by index. */
  rows: z.array(z.array(z.unknown())),
  upsertKeys: z.array(SqlIdentifier).min(1),
  timeoutMs: z.number().int().positive().default(15000),
  context: WriteContext,
});
export type WriteRequest = z.infer<typeof WriteRequest>;

export const WriteResponse = z.object({
  written: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
});
export type WriteResponse = z.infer<typeof WriteResponse>;

/**
 * Phase 11 Block 2E — post-assertions run by the connector against the
 * staging table, in the SAME transaction as the apply DML, before it. Fixed
 * kinds only (no raw predicate text) so every assertion compiles to a
 * connector-authored, dialect-specific SQL template — same "structured
 * request, connector builds the SQL" posture as the rest of the write path.
 * `noNullKeys` is always run by the worker in addition to whatever the op
 * registry declares (see packages/schemas/src/ops/types.ts's
 * `OpModule.stagingAssertions`); `uniqueColumns` is what the aggregate op
 * declares for its groupBy columns. `maxFailureRate`/`replaceShrinkGuard`
 * are evaluated by the connector from counts it already has mid-transaction
 * (quarantine rows for this run; staging vs. destination row counts) rather
 * than a client-supplied number, so a caller can't lie about the ratio.
 */
export const AssertionSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("noNullKeys"), columns: z.array(SqlIdentifier).min(1) }),
  z.object({ kind: z.literal("uniqueColumns"), columns: z.array(SqlIdentifier).min(1) }),
  z.object({ kind: z.literal("maxFailureRate"), maxRate: z.number().min(0).max(1) }),
  z.object({
    kind: z.literal("replaceShrinkGuard"),
    minRatio: z.number().min(0).max(1).default(0.5),
    allowShrink: z.boolean().default(false),
  }),
]);
export type AssertionSpec = z.infer<typeof AssertionSpec>;

export const AssertionResult = z.object({
  spec: AssertionSpec,
  ok: z.boolean(),
  detail: z.string().optional(),
});
export type AssertionResult = z.infer<typeof AssertionResult>;

/**
 * Phase 11 Block 2A/2B — the staging lifecycle. One endpoint, discriminated
 * by `op`, rather than three endpoints, since all three share the same
 * signed-context re-check (entity/stagingEntity/quarantineEntity/mode/runId
 * must deep-equal the SAME fields inside `context` — see WriteContext's
 * doc comment) before touching anything. `create`/`drop` act only on
 * `stagingEntity` (and `drop` additionally drops `quarantineEntity`'s
 * *pending* rows for this run, never the quarantine table itself — that
 * table is shared across runs). `apply` is the one destination-mutating op:
 * it runs `assertions` against staging, and only on success applies staging
 * to `entity` per `mode` and marks this run's quarantine rows committed —
 * all inside one connector-side transaction (see each connector's
 * `stagingSql.ts` for the exact DDL/DML templates).
 */
export const StageOp = z.enum(["create", "apply", "drop"]);
export type StageOp = z.infer<typeof StageOp>;

export const StageRequest = z.object({
  credential: CredentialRef,
  config: ConnectorConfig,
  op: StageOp,
  entity: WriteEntityRef,
  stagingEntity: WriteEntityRef,
  quarantineEntity: WriteEntityRef.nullable().default(null),
  runId: z.string().uuid(),
  mode: WriteMode.default("upsert"),
  /** Same convention as WriteRequest.upsertKeys — real column identifiers, used by `create` (LIKE dest) and `apply` (ON CONFLICT/DUPLICATE KEY). */
  upsertKeys: z.array(SqlIdentifier).min(1),
  /** Only consulted by `apply`; ignored by `create`/`drop`. */
  assertions: z.array(AssertionSpec).default([]),
  timeoutMs: z.number().int().positive().default(30000),
  context: WriteContext,
});
export type StageRequest = z.infer<typeof StageRequest>;

export const StageResponse = z.object({
  op: StageOp,
  ok: z.boolean(),
  /** `apply` only: each assertion's outcome, in the order they were declared. Empty for create/drop. */
  assertionResults: z.array(AssertionResult).default([]),
  /** `apply` only: rows moved from staging into the destination. */
  applied: z.number().int().nonnegative().optional(),
  /** `apply` only: this run's quarantine rows marked committed. */
  quarantined: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});
export type StageResponse = z.infer<typeof StageResponse>;

/**
 * Phase 11 Block 2D — preflight. Unsigned and read-only (mirrors
 * `/introspect`'s posture: no mutation, so no signed context needed),
 * called once before extraction starts. Each check names the privilege it
 * verified and, on failure, the exact grant SQL an operator needs to run —
 * so a missing-privilege run fails fast with an actionable message instead
 * of partway through staging DDL.
 */
export const PreflightRequest = z.object({
  credential: CredentialRef,
  config: ConnectorConfig,
  entity: WriteEntityRef,
  upsertKeys: z.array(SqlIdentifier).min(1),
});
export type PreflightRequest = z.infer<typeof PreflightRequest>;

export const PreflightCheck = z.object({
  name: z.string(),
  ok: z.boolean(),
  message: z.string().optional(),
  grantSql: z.string().optional(),
});
export type PreflightCheck = z.infer<typeof PreflightCheck>;

export const PreflightResponse = z.object({
  ok: z.boolean(),
  checks: z.array(PreflightCheck),
});
export type PreflightResponse = z.infer<typeof PreflightResponse>;

/**
 * Schema layer, Part 4 — destination-contract creation. One new signed
 * request kind, `/create-entity`, structured the same way as StageRequest:
 * the worker (destinationContract.ts's buildDestinationContract) already
 * resolved every column's dialect-native type via niaAdapters.ts's
 * fromNiaType() before this ever gets built, so the connector's own job is
 * purely mechanical — build `CREATE TABLE/COLLECTION IF NOT EXISTS` from a
 * fixed template using these pre-resolved native-type strings, never a
 * NiaType translation of its own. This keeps exactly one place (the
 * worker, via niaAdapters.ts) owning the NiaType -> native-type mapping,
 * matching Part 1's "N + M mappings, not N x M" framing — a connector
 * never needs its own copy of that logic.
 *
 * Reuses WriteContext for the signed binding (entity + columns, the same
 * two fields a plain WriteRequest signs) rather than inventing new signed
 * fields: `columns` in the signed context is `columns.map(c => c.name)`,
 * `stagingEntity`/`quarantineEntity` are null, `mode` is the schema
 * default ("upsert", unused by create-entity but required by
 * WriteContext's shape), and `runId` is the run this creation happens
 * inside of (Part 4's "Runs in preflight, before staging" — always called
 * from within a run, job.cursor === null, same gate as ensureStaging).
 */
export const CreateColumnSpec = z.object({
  name: SqlIdentifier,
  /** Dialect-native column/field type string, already resolved by niaAdapters.ts's fromNiaType() — verbatim SQL DDL type text (e.g. "BIGINT", "JSONB") for SQL dialects, a BSON type name for Mongo. */
  nativeType: z.string().min(1),
  nullable: z.boolean(),
});
export type CreateColumnSpec = z.infer<typeof CreateColumnSpec>;

export const CreateEntityKind = z.enum(["table", "collection"]);
export type CreateEntityKind = z.infer<typeof CreateEntityKind>;

export const CreateEntityRequest = z.object({
  credential: CredentialRef,
  config: ConnectorConfig,
  kind: CreateEntityKind,
  entity: WriteEntityRef,
  columns: z.array(CreateColumnSpec).min(1),
  /** Key column(s) — become the primary key (SQL) or a unique index (Mongo). */
  keys: z.array(SqlIdentifier).min(1),
  timeoutMs: z.number().int().positive().default(30000),
  context: WriteContext,
});
export type CreateEntityRequest = z.infer<typeof CreateEntityRequest>;

export const CreateEntityResponse = z.object({
  /** True if this call actually issued the CREATE (first time). False if the entity already existed (idempotent no-op — caller compares its contract against a fresh /introspect instead of trusting this call did anything). */
  created: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type CreateEntityResponse = z.infer<typeof CreateEntityResponse>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string(),
  pools: z.number().int().nonnegative(),
  /**
   * The connector-service's actually-registered route names (e.g.
   * ["test","introspect","execute","invalidate","write"]) — lets a caller
   * detect route skew (e.g. an older service image that predates /write)
   * before dispatching, instead of hitting a raw 404 mid-job. See
   * apps/worker/src/lib/routeAwareness.ts. Full version handshake deferred
   * to Phase 9 hardening — this is a lightweight stopgap.
   */
  routes: z.array(z.string()),
});

export type TestRequest = z.infer<typeof TestRequest>;
export type TestResponse = z.infer<typeof TestResponse>;
export type IntrospectRequest = z.infer<typeof IntrospectRequest>;
export type IntrospectResponse = z.infer<typeof IntrospectResponse>;
export type ExecuteRequest = z.infer<typeof ExecuteRequest>;
export type ExecuteResponse = z.infer<typeof ExecuteResponse>;
export type InvalidateRequest = z.infer<typeof InvalidateRequest>;
export type InvalidateResponse = z.infer<typeof InvalidateResponse>;
export type HealthResponse = z.infer<typeof HealthResponse>;
