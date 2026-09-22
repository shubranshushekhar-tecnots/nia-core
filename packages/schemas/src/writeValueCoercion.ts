/**
 * The SQL connectors' (mysql, postgres/supabase) write-layer JSON guard.
 *
 * `pg` parses jsonb source columns into JS objects/arrays on read, and
 * mysql2 does the same for MySQL's JSON type — but naively re-binding
 * those same values as write parameters is dialect-dependent and, for
 * MySQL, silently wrong: mysql2's default SqlString escaping stringifies
 * a plain object via `.toString()`, producing the literal text
 * `"[object Object]"`, not JSON. Postgres's jsonb binding is more
 * forgiving but still undocumented/unverified for every non-jsonb column
 * type an object/array could land on by mistake (e.g. a text column,
 * or an array value bound to a scalar column).
 *
 * This is the one place both SQL connectors funnel every outbound row
 * through before building the UPSERT: JSON.stringify an object/array
 * value bound for a JSON-typed destination column, and refuse (loudly,
 * before any SQL runs) an object/array value bound for any other
 * declared destination type — never silently stringify-and-hope, and
 * never let `[object Object]` reach a table.
 *
 * Each connector supplies its own `isJsonColumn` predicate (built from
 * that dialect's own declared-type text — 'json'/'jsonb' for postgres,
 * 'json' for mysql) and calls `rowsNeedJsonCoercion` first so a normal
 * all-scalar write never pays for a destination-column-type lookup.
 */

export function rowsNeedJsonCoercion(rows: unknown[][]): boolean {
  return rows.some((row) => row.some((value) => isObjectOrArrayValue(value)));
}

function isObjectOrArrayValue(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !(typeof Buffer !== "undefined" && Buffer.isBuffer(value))
  );
}

export type JsonWriteCoercionResult = { ok: true; rows: unknown[][] } | { ok: false; error: string };

export function coerceJsonWriteValues(
  columns: string[],
  rows: unknown[][],
  isJsonColumn: (column: string) => boolean,
): JsonWriteCoercionResult {
  const coercedRows: unknown[][] = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    const coercedRow: unknown[] = new Array(row.length);
    for (let c = 0; c < columns.length; c++) {
      const value = row[c];
      if (!isObjectOrArrayValue(value)) {
        coercedRow[c] = value;
        continue;
      }
      const column = columns[c]!;
      if (!isJsonColumn(column)) {
        return {
          ok: false,
          error: `Column "${column}" (row ${r}) received an object/array value, but its destination type is not JSON — refusing to write it (this would otherwise be silently stringified as "[object Object]", or fail). Map this column to a JSON-typed destination column, or transform the value to a scalar before writing.`,
        };
      }
      coercedRow[c] = JSON.stringify(value);
    }
    coercedRows.push(coercedRow);
  }
  return { ok: true, rows: coercedRows };
}
