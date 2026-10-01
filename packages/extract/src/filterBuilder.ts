import { resolveColumn, resolveTable, UnknownColumnError } from "./catalog.js";
import { assertSafeIdentifierText, type ParamSink } from "./paramSink.js";
import { FILTER_OPERATORS, MAX_IN_VALUES, type Catalog, type CatalogTable, type ExtractRequest, type FilterCondition } from "./types.js";

export class UnknownOperatorError extends Error {
  constructor(operator: string) {
    super(`unknown filter operator ${JSON.stringify(operator)}`);
    this.name = "UnknownOperatorError";
  }
}

export class InvalidFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFilterError";
  }
}

/**
 * Validates an ExtractRequest against the catalog: table and every
 * referenced column (in `columns` and in `filter`) must resolve by exact
 * lookup. Returns the resolved table plus the ordered list of selected
 * columns, ready for a dialect module to compile into SQL.
 */
export function validateExtractRequest(catalog: Catalog, request: ExtractRequest): { table: CatalogTable; columns: string[] } {
  const table = resolveTable(catalog, request.table);
  for (const column of request.columns) {
    resolveColumn(table, column);
  }
  for (const cond of request.filter) {
    resolveColumn(table, cond.column);
    validateCondition(cond);
  }
  const columns = request.columns.length > 0 ? request.columns : table.columns.map((c) => c.name);
  return { table, columns };
}

function validateCondition(cond: FilterCondition): void {
  if (!(FILTER_OPERATORS as readonly string[]).includes(cond.operator)) {
    throw new UnknownOperatorError(cond.operator);
  }
  if (cond.operator === "in") {
    if (cond.values.length === 0) throw new InvalidFilterError(`"in" filter on ${JSON.stringify(cond.column)} must have at least one value`);
    if (cond.values.length > MAX_IN_VALUES) {
      throw new InvalidFilterError(`"in" filter on ${JSON.stringify(cond.column)} exceeds the ${MAX_IN_VALUES}-value limit (got ${cond.values.length})`);
    }
  }
}

/** Escapes `%`/`_` in a literal startsWith prefix so it can't act as a LIKE wildcard; `escapeChar` must match whatever `ESCAPE` clause the dialect's compiled SQL uses. */
export function escapeLikeWildcards(value: string, escapeChar = "\\"): string {
  const escaped = value.split(escapeChar).join(escapeChar + escapeChar);
  return escaped.split("%").join(escapeChar + "%").split("_").join(escapeChar + "_");
}

export interface WhereClauseAdapter {
  quoteIdent(name: string): string;
  /** `startsWith` is pre-escaped (see escapeLikeWildcards) and compiled as a LIKE with this adapter's ESCAPE clause/char. */
  likeEscapeChar: string;
}

/**
 * Dialect-agnostic WHERE clause compiler: given a quoting function and a
 * ParamSink, turns AND-joined FilterCondition[] into parameterized SQL
 * text. Any SQL dialect module (SQL Server now, others later) supplies
 * `quoteIdent` and reads the returned fragments.
 */
export function compileWhereClause(filter: FilterCondition[], adapter: WhereClauseAdapter, params: ParamSink): string[] {
  return filter.map((cond) => {
    assertSafeIdentifierText(cond.column);
    const target = adapter.quoteIdent(cond.column);
    switch (cond.operator) {
      case "isNull":
        return `${target} IS NULL`;
      case "isNotNull":
        return `${target} IS NOT NULL`;
      case "eq":
        return `${target} = ${params.push(cond.value)}`;
      case "neq":
        return `${target} <> ${params.push(cond.value)}`;
      case "gt":
        return `${target} > ${params.push(cond.value)}`;
      case "gte":
        return `${target} >= ${params.push(cond.value)}`;
      case "lt":
        return `${target} < ${params.push(cond.value)}`;
      case "lte":
        return `${target} <= ${params.push(cond.value)}`;
      case "between":
        return `${target} BETWEEN ${params.push(cond.low)} AND ${params.push(cond.high)}`;
      case "in": {
        const tokens = cond.values.map((v) => params.push(v));
        return `${target} IN (${tokens.join(", ")})`;
      }
      case "startsWith": {
        if (typeof cond.value !== "string") {
          throw new InvalidFilterError(`"startsWith" filter on ${JSON.stringify(cond.column)} requires a string value`);
        }
        const escaped = escapeLikeWildcards(cond.value, adapter.likeEscapeChar);
        const token = params.push(`${escaped}%`);
        return `${target} LIKE ${token} ESCAPE '${adapter.likeEscapeChar}'`;
      }
      default: {
        const exhaustive: never = cond;
        throw new UnknownOperatorError((exhaustive as FilterCondition).operator);
      }
    }
  });
}

export { UnknownColumnError };
