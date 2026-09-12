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
      fields: z.array(z.object({ name: z.string(), type: z.string() })),
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

export const HealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string(),
  pools: z.number().int().nonnegative(),
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
