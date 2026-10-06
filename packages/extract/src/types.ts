/**
 * Planometry contract types (docs/plans/planometry-integration.md). This
 * package is standalone — no dependency on Nia's app/API/database — so an
 * on-premise agent can embed it later regardless of which delivery
 * mechanism (Phase 2) is eventually chosen.
 *
 * Deliberately a flat, closed 5-type system distinct from
 * `@nia/schemas`'s `NiaTypeKind` (string/integer/float/decimal/boolean/
 * date/timestamp/bytes/json/object/array): that system serves the ETL
 * pushdown/profiling engine and is a different, richer contract. Don't
 * conflate the two.
 */
export type ExtractType = "text" | "number" | "date" | "datetime" | "boolean";

export interface CatalogColumn {
  name: string;
  type: ExtractType;
  nullable: boolean;
}

export interface ExcludedColumn {
  name: string;
  nativeType: string;
  reason: string;
}

export interface CatalogTable {
  /** Exact identifier accepted back in an Extract request (e.g. schema-qualified "dbo.vw_salesdata"). Never parsed — always looked up against this catalog. */
  name: string;
  kind: "table" | "view";
  columns: CatalogColumn[];
  excluded: ExcludedColumn[];
  /**
   * Slice T2 — the table's PRIMARY KEY column(s), in key-ordinal order, or
   * null if the table has no primary key. Unlike @nia/schemas's
   * IntrospectResponse.entity.primaryKey (a single string, by design —
   * see that field's own doc comment: a composite key there is collapsed
   * to null, "treated the same as no key found"), this package's own
   * keyset-read capability is genuinely composite-aware: a 2+ column
   * array here can still be paged with buildSelectSql's keyset ORDER BY/
   * cursor support. Collapsing to the wire's single-string convention is
   * the caller's job (apps/agent's taskRunner.ts), not this package's.
   */
  primaryKey: string[] | null;
}

export interface Catalog {
  generatedAt: string;
  sourceTimeZone: string;
  tables: CatalogTable[];
}

export const FILTER_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "between",
  "startsWith",
  "isNull",
  "isNotNull",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterScalar = string | number | boolean;

/** Discriminated by `operator` so each variant only carries the value shape that operator needs. */
export type FilterCondition =
  | { column: string; operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "startsWith"; value: FilterScalar }
  | { column: string; operator: "in"; values: FilterScalar[] }
  | { column: string; operator: "between"; low: FilterScalar; high: FilterScalar }
  | { column: string; operator: "isNull" | "isNotNull" };

export interface ExtractRequest {
  table: string;
  columns: string[];
  /** AND-joined. A filter column needn't be in `columns`. */
  filter: FilterCondition[];
}

export const MAX_IN_VALUES = 1000;
