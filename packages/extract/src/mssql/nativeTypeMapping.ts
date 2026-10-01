import type { ExtractType } from "../types.js";

export interface NativeTypeInfo {
  extractType: ExtractType | null;
  /** Only set when extractType is null. */
  reason?: string;
  /**
   * Whether the generated SELECT must cast this column to text rather
   * than let the driver convert it natively. True for anything where the
   * driver's native JS representation would lose precision or (for
   * naive datetime-family types) silently assume the wrong timezone —
   * see mssql/buildSelectSql.ts's comment for the full reasoning on why
   * this list is a superset of docs/plans/planometry-integration.md's
   * literal "decimal/numeric/money, bigint, datetime2, datetimeoffset,
   * time" (datetime/smalldatetime are included here too).
   */
  castToText: boolean;
}

const EXACT_NUMERIC = new Set(["decimal", "numeric", "money", "smallmoney", "bigint"]);
const FLOATING_NUMERIC = new Set(["float", "real"]);
const WHOLE_NUMBER = new Set(["int", "smallint", "tinyint"]);
const TEXT_PASSTHROUGH = new Set(["varchar", "nvarchar", "char", "nchar", "xml", "time"]);
const EXCLUDED = new Set(["varbinary", "image", "geography", "geometry", "hierarchyid", "sql_variant"]);

/** `nativeType` is SQL Server's `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE`, matched case-insensitively. */
export function nativeTypeInfo(nativeType: string): NativeTypeInfo {
  const t = nativeType.toLowerCase();

  if (t === "bit") return { extractType: "boolean", castToText: false };
  if (t === "uniqueidentifier") return { extractType: "text", castToText: false };
  if (TEXT_PASSTHROUGH.has(t)) return { extractType: "text", castToText: t === "time" };
  if (WHOLE_NUMBER.has(t)) return { extractType: "number", castToText: false };
  if (EXACT_NUMERIC.has(t)) return { extractType: "number", castToText: true };
  if (FLOATING_NUMERIC.has(t)) return { extractType: "number", castToText: false };
  if (t === "date") return { extractType: "date", castToText: false };
  if (t === "datetime" || t === "smalldatetime") return { extractType: "datetime", castToText: true };
  if (t === "datetime2" || t === "datetimeoffset") return { extractType: "datetime", castToText: true };
  if (EXCLUDED.has(t)) return { extractType: null, reason: `${t} columns are not supported`, castToText: false };

  return { extractType: null, reason: `${t} is not a recognized or supported type`, castToText: false };
}
