import type { ColumnType } from "@nia/schemas";

/**
 * Postgres builtin type OIDs -> our ColumnType. Unlike connector-mysql
 * (which still has a TODO and returns "unknown" unconditionally), this is a
 * real mapping — "unknown" here is reserved only for genuinely
 * unmapped/exotic types (money, inet, cidr, macaddr, geometric types,
 * tsvector/tsquery, oid, regclass, ranges, etc.), not a blanket default.
 *
 * OIDs are stable, well-known Postgres builtins (see pg_type catalog) —
 * safe to hardcode rather than query at runtime.
 */
const OID_TO_COLUMN_TYPE: Record<number, ColumnType> = {
  16: "boolean", // bool
  17: "binary", // bytea
  18: "string", // char
  19: "string", // name
  20: "number", // int8
  21: "number", // int2
  23: "number", // int4
  25: "string", // text
  114: "json", // json
  142: "string", // xml
  700: "number", // float4
  701: "number", // float8
  1042: "string", // bpchar
  1043: "string", // varchar
  1082: "date", // date
  1083: "string", // time
  1114: "date", // timestamp
  1184: "date", // timestamptz
  1186: "string", // interval
  1700: "number", // numeric
  2950: "string", // uuid
  3802: "json", // jsonb
  // Array variants — represented as JSON arrays in tabular output.
  199: "json", // _json
  1000: "json", // _bool
  1005: "json", // _int2
  1007: "json", // _int4
  1009: "json", // _text
  1015: "json", // _varchar
  1016: "json", // _int8
  1021: "json", // _float4
  1022: "json", // _float8
  1115: "json", // _timestamp
  1185: "json", // _timestamptz
  1231: "json", // _numeric
  2951: "json", // _uuid
  3807: "json", // _jsonb
};

export function mapPostgresColumnType(dataTypeID: number): ColumnType {
  return OID_TO_COLUMN_TYPE[dataTypeID] ?? "unknown";
}
