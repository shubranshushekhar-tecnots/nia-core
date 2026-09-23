import type { SourceDialect } from "./ops/types.js";
import type { NiaField, NiaSchema, NiaType } from "./niaType.js";

/**
 * Schema layer, Part 1 — per-dialect NiaType adapters. Each dialect
 * declares both directions (native -> NiaType for sources, NiaType ->
 * native for destinations), each mapping marked lossless or lossy with a
 * reason, so N sources + M destinations need N + M mappings, not N × M.
 * See docs/plans/schema-layer.md.
 *
 * "Native type" vocabulary per dialect matches exactly what this
 * codebase's connectors already put in IntrospectResponse.fields[].type
 * (contract.ts) — not some idealized DB type-system:
 *   - mysql / postgres: `information_schema.columns.data_type`, verbatim
 *     (services/connector-mysql, services/connector-supabase's /introspect).
 *   - mongo: this repo's own ColumnType enum (tabular.ts) — connector-
 *     mongodb's /introspect already resolves each flattened field (see
 *     services/connector-mongodb/src/flatten.ts + column-types.ts) to one
 *     of "string" | "number" | "boolean" | "date" | "json" | "binary" |
 *     "unknown" before this adapter ever sees it; there is no raw BSON
 *     vocabulary to adapt from at this layer.
 */

export type Fidelity = { kind: "lossless" } | { kind: "lossy"; reason: string };

const lossless: Fidelity = { kind: "lossless" };
function lossy(reason: string): Fidelity {
  return { kind: "lossy", reason };
}

export interface DialectAdapter {
  dialect: SourceDialect;
  /** Native type string -> NiaType. Powers schemaFromIntrospection() below (declared SQL/Mongo source schemas). */
  toNiaType(nativeType: string): { type: NiaType; fidelity: Fidelity };
  /** NiaType -> this dialect's native column/field type string, for destination-contract DDL (Part 4). */
  fromNiaType(type: NiaType): { nativeType: string; fidelity: Fidelity };
}

// ---------------------------------------------------------------------------
// MySQL
// ---------------------------------------------------------------------------

const MYSQL_INTEGER = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
const MYSQL_STRING = new Set(["char", "varchar", "tinytext", "text", "mediumtext", "longtext"]);
const MYSQL_BYTES = new Set(["binary", "varbinary", "blob", "tinyblob", "mediumblob", "longblob"]);

function mysqlToNiaType(nativeType: string): { type: NiaType; fidelity: Fidelity } {
  const t = nativeType.toLowerCase();
  if (MYSQL_INTEGER.has(t)) return { type: { kind: "integer" }, fidelity: lossless };
  if (t === "decimal" || t === "numeric") return { type: { kind: "decimal" }, fidelity: lossless };
  if (t === "float" || t === "double") return { type: { kind: "float" }, fidelity: lossless };
  if (MYSQL_STRING.has(t)) return { type: { kind: "string" }, fidelity: lossless };
  if (t === "date") return { type: { kind: "date" }, fidelity: lossless };
  if (t === "datetime") return { type: { kind: "timestamp", tz: "naive" }, fidelity: lossless };
  if (t === "timestamp") return { type: { kind: "timestamp", tz: "utc" }, fidelity: lossless };
  if (t === "time") return { type: { kind: "string" }, fidelity: lossy("no NiaType kind for time-of-day; represented as a plain string") };
  if (t === "year") return { type: { kind: "integer" }, fidelity: lossy("YEAR's declared year semantics are not preserved distinctly from a plain integer") };
  if (t === "json") return { type: { kind: "json" }, fidelity: lossless };
  if (MYSQL_BYTES.has(t)) return { type: { kind: "bytes" }, fidelity: lossless };
  if (t === "bit") return { type: { kind: "bytes" }, fidelity: lossy("BIT column's declared bit-width is not preserved") };
  if (t === "enum" || t === "set") return { type: { kind: "string" }, fidelity: lossy(`${t.toUpperCase()}'s constrained value set is not preserved, represented as a plain string`) };
  return { type: { kind: "json" }, fidelity: lossy(`unrecognized mysql data_type "${nativeType}"`) };
}

function mysqlFromNiaType(type: NiaType): { nativeType: string; fidelity: Fidelity } {
  switch (type.kind) {
    case "string":
      if (type.format === "uuid") return { nativeType: "CHAR(36)", fidelity: lossless };
      if (type.format === "objectId") return { nativeType: "VARCHAR(24)", fidelity: lossless };
      // Plan's literal example ("VARCHAR(255) for string keys") used as the
      // default here — Part 4's destination-contract builder is expected to
      // widen this to TEXT for long-form, non-key string columns once it
      // knows which fields are keys.
      return { nativeType: "VARCHAR(255)", fidelity: lossless };
    case "integer":
      return { nativeType: "BIGINT", fidelity: lossless };
    case "float":
      return { nativeType: "DOUBLE", fidelity: lossless };
    case "decimal":
      if (type.precision !== undefined && type.scale !== undefined) {
        return { nativeType: `DECIMAL(${type.precision},${type.scale})`, fidelity: lossless };
      }
      return { nativeType: "DOUBLE", fidelity: lossy("unknown precision/scale; falling back to floating-point DOUBLE loses exact decimal semantics") };
    case "boolean":
      return { nativeType: "TINYINT(1)", fidelity: lossless };
    case "date":
      return { nativeType: "DATE", fidelity: lossless };
    case "timestamp":
      return { nativeType: type.tz === "utc" ? "TIMESTAMP" : "DATETIME", fidelity: lossless };
    case "bytes":
      return { nativeType: "BLOB", fidelity: lossless };
    case "json":
      return { nativeType: "JSON", fidelity: lossless };
    case "object":
      return { nativeType: "JSON", fidelity: lossy("structured object collapsed into one opaque JSON column; per-field types are not enforced by the destination schema") };
    case "array":
      return { nativeType: "JSON", fidelity: lossy("array serialized as JSON; element type is not enforced by the destination schema") };
  }
}

// ---------------------------------------------------------------------------
// Postgres
// ---------------------------------------------------------------------------

const POSTGRES_INTEGER = new Set(["smallint", "integer", "bigint"]);
const POSTGRES_STRING = new Set(["character varying", "character", "text", "name", "citext"]);

function postgresToNiaType(nativeType: string): { type: NiaType; fidelity: Fidelity } {
  const t = nativeType.toLowerCase();
  if (POSTGRES_INTEGER.has(t)) return { type: { kind: "integer" }, fidelity: lossless };
  if (t === "numeric" || t === "decimal") {
    // connector-supabase's /introspect only selects information_schema's
    // bare `data_type`, not numeric_precision/numeric_scale, so precision
    // can't be populated here — a real (if narrow) gap, not an oversight.
    return { type: { kind: "decimal" }, fidelity: lossy("precision/scale not derivable from this connector's current introspection query") };
  }
  if (t === "real" || t === "double precision") return { type: { kind: "float" }, fidelity: lossless };
  if (POSTGRES_STRING.has(t)) return { type: { kind: "string" }, fidelity: lossless };
  if (t === "boolean") return { type: { kind: "boolean" }, fidelity: lossless };
  if (t === "date") return { type: { kind: "date" }, fidelity: lossless };
  if (t === "timestamp without time zone") return { type: { kind: "timestamp", tz: "naive" }, fidelity: lossless };
  if (t === "timestamp with time zone") return { type: { kind: "timestamp", tz: "utc" }, fidelity: lossless };
  if (t === "time without time zone" || t === "time with time zone") {
    return { type: { kind: "string" }, fidelity: lossy("no NiaType kind for time-of-day; represented as a plain string") };
  }
  if (t === "uuid") return { type: { kind: "string", format: "uuid" }, fidelity: lossless };
  if (t === "json" || t === "jsonb") return { type: { kind: "json" }, fidelity: lossless };
  if (t === "bytea") return { type: { kind: "bytes" }, fidelity: lossless };
  if (t === "array") {
    return { type: { kind: "json" }, fidelity: lossy("postgres array column collapsed to json; element type is not resolved from information_schema.data_type") };
  }
  if (t === "user-defined") {
    return { type: { kind: "string" }, fidelity: lossy("custom/enum postgres type not resolved to a specific NiaType") };
  }
  return { type: { kind: "json" }, fidelity: lossy(`unrecognized postgres data_type "${nativeType}"`) };
}

function postgresFromNiaType(type: NiaType): { nativeType: string; fidelity: Fidelity } {
  switch (type.kind) {
    case "string":
      if (type.format === "uuid") return { nativeType: "UUID", fidelity: lossless };
      if (type.format === "objectId") {
        return { nativeType: "TEXT", fidelity: lossy("no native postgres type preserves the objectId format hint; stored as plain text") };
      }
      return { nativeType: "TEXT", fidelity: lossless };
    case "integer":
      return { nativeType: "BIGINT", fidelity: lossless };
    case "float":
      return { nativeType: "DOUBLE PRECISION", fidelity: lossless };
    case "decimal":
      if (type.precision !== undefined && type.scale !== undefined) {
        return { nativeType: `NUMERIC(${type.precision},${type.scale})`, fidelity: lossless };
      }
      return { nativeType: "NUMERIC", fidelity: lossless };
    case "boolean":
      return { nativeType: "BOOLEAN", fidelity: lossless };
    case "date":
      return { nativeType: "DATE", fidelity: lossless };
    case "timestamp":
      return { nativeType: type.tz === "utc" ? "TIMESTAMPTZ" : "TIMESTAMP", fidelity: lossless };
    case "bytes":
      return { nativeType: "BYTEA", fidelity: lossless };
    case "json":
      return { nativeType: "JSONB", fidelity: lossless };
    case "object":
      return { nativeType: "JSONB", fidelity: lossy("structured object collapsed into one opaque jsonb column; per-field types are not enforced by the destination schema") };
    case "array":
      return { nativeType: "JSONB", fidelity: lossy("array serialized as jsonb rather than a native postgres array; element type is not enforced by the destination schema") };
  }
}

// ---------------------------------------------------------------------------
// Mongo
// ---------------------------------------------------------------------------

function mongoToNiaType(nativeType: string): { type: NiaType; fidelity: Fidelity } {
  switch (nativeType) {
    case "string":
      return { type: { kind: "string" }, fidelity: lossless };
    case "number":
      // ColumnType "number" covers BSON Long/Int32/Double alike (column-
      // types.ts's inferColumnType) — can't distinguish int from float
      // from this label alone, so pick the wider kind, same precedent as
      // join()'s own integer⊔float=float.
      return { type: { kind: "float" }, fidelity: lossless };
    case "boolean":
      return { type: { kind: "boolean" }, fidelity: lossless };
    case "date":
      // BSON Date always carries full timestamp (not just a calendar
      // date) and is UTC-based.
      return { type: { kind: "timestamp", tz: "utc" }, fidelity: lossless };
    case "json":
      return { type: { kind: "json" }, fidelity: lossless };
    case "binary":
      return { type: { kind: "bytes" }, fidelity: lossless };
    case "unknown":
      return { type: { kind: "json" }, fidelity: lossy("connector observed no non-null sample values to infer a type") };
    default:
      return { type: { kind: "json" }, fidelity: lossy(`unrecognized mongo ColumnType "${nativeType}"`) };
  }
}

function mongoFromNiaType(type: NiaType): { nativeType: string; fidelity: Fidelity } {
  switch (type.kind) {
    case "string":
      return { nativeType: "string", fidelity: lossless };
    case "integer":
      return { nativeType: "long", fidelity: lossless };
    case "float":
      return { nativeType: "double", fidelity: lossless };
    case "decimal":
      if (type.precision !== undefined && type.scale !== undefined) {
        return { nativeType: "decimal128", fidelity: lossless };
      }
      return { nativeType: "double", fidelity: lossy("unknown precision/scale; Decimal128 not selected, falling back to double loses exact decimal semantics") };
    case "boolean":
      return { nativeType: "boolean", fidelity: lossless };
    case "date":
      return { nativeType: "date", fidelity: lossless };
    case "timestamp":
      if (type.tz === "naive") {
        return { nativeType: "date", fidelity: lossy("BSON Date has no naive/timezone-less representation; a naive timestamp is forced into a UTC instant") };
      }
      return { nativeType: "date", fidelity: lossless };
    case "bytes":
      return { nativeType: "binData", fidelity: lossless };
    case "json":
      return { nativeType: "object", fidelity: lossy("opaque json value stored as a generic BSON document; original structure is not statically resolved") };
    case "object":
      return { nativeType: "object", fidelity: lossless };
    case "array":
      return { nativeType: "array", fidelity: lossless };
  }
}

export const MYSQL_ADAPTER: DialectAdapter = { dialect: "mysql", toNiaType: mysqlToNiaType, fromNiaType: mysqlFromNiaType };
export const POSTGRES_ADAPTER: DialectAdapter = { dialect: "postgres", toNiaType: postgresToNiaType, fromNiaType: postgresFromNiaType };
export const MONGO_ADAPTER: DialectAdapter = { dialect: "mongo", toNiaType: mongoToNiaType, fromNiaType: mongoFromNiaType };

export const DIALECT_ADAPTERS: Record<SourceDialect, DialectAdapter> = {
  mysql: MYSQL_ADAPTER,
  postgres: POSTGRES_ADAPTER,
  mongo: MONGO_ADAPTER,
};

export function getDialectAdapter(dialect: SourceDialect): DialectAdapter {
  return DIALECT_ADAPTERS[dialect];
}

/**
 * Declared SQL/Mongo source schemas become NiaSchemas through the
 * dialect's toNiaType() mapping. IntrospectResponse (contract.ts) carries
 * no NOT NULL constraint today (`fields: {name, type}[]`, nothing else) —
 * declared fields default to nullable: true until that's added; they
 * never carry `presence` (a declared column always structurally exists).
 */
export function schemaFromIntrospection(
  entity: { fields: { name: string; type: string }[] },
  dialect: SourceDialect,
): { schema: NiaSchema; fidelity: Record<string, Fidelity> } {
  const adapter = getDialectAdapter(dialect);
  const fields: Record<string, NiaField> = {};
  const fidelity: Record<string, Fidelity> = {};
  for (const f of entity.fields) {
    const { type, fidelity: fieldFidelity } = adapter.toNiaType(f.type);
    fields[f.name] = { type, nullable: true };
    fidelity[f.name] = fieldFidelity;
  }
  return { schema: { fields }, fidelity };
}
