import type { Catalog, CatalogColumn, CatalogTable } from "./types.js";

export class UnknownTableError extends Error {
  constructor(table: string) {
    super(`unknown table ${JSON.stringify(table)}`);
    this.name = "UnknownTableError";
  }
}

export class UnknownColumnError extends Error {
  constructor(table: string, column: string) {
    super(`unknown column ${JSON.stringify(column)} on table ${JSON.stringify(table)}`);
    this.name = "UnknownColumnError";
  }
}

/**
 * Identifiers are NEVER parsed from caller input — only ever looked up
 * against the catalog the server itself generated. A table/column name
 * that isn't an exact match for a catalog entry is rejected outright.
 */
export function resolveTable(catalog: Catalog, table: string): CatalogTable {
  const found = catalog.tables.find((t) => t.name === table);
  if (!found) throw new UnknownTableError(table);
  return found;
}

export function resolveColumn(table: CatalogTable, column: string): CatalogColumn {
  const found = table.columns.find((c) => c.name === column);
  if (!found) throw new UnknownColumnError(table.name, column);
  return found;
}
