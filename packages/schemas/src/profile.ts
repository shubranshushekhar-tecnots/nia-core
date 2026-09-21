import { z } from "zod";

/**
 * Phase 10 — source profiling. Schemas for the stats/signature a worker
 * job computes over a sample of one entity's rows, and the shape cached in
 * supabase/migrations/0020_source_profiles.sql's `source_profiles` table.
 *
 * Reuses @nia/schemas' own residual evaluator (ops/residualEval.ts's
 * evalExpr) for every parse-rate stat below — see profileEntity.ts in
 * apps/worker for the call sites. This file only defines the OUTPUT shape;
 * it has no evaluator logic of its own.
 */

/** Trimmed + lowercased match set — one constant, per the Phase 10 plan (docs/plans/phase10.md, Step 3B). Not a parse function; counted separately from NULL/empty/whitespace so a source that spells out "N/A" instead of leaving a true NULL is still visible in the profile. */
export const MISSING_VALUE_TOKENS = new Set(["n/a", "na", "null", "none", "nil", "-", "?", "#n/a"]);

/**
 * One candidate parse_date format per the plan's list. `token` is the
 * literal string residualEval.ts's parse_date second arg expects (its own
 * YYYY/MM/DD/HH/mm/ss token vocabulary, see that file's compileDateFormatToRegex);
 * `key` is the stable identifier used in ColumnStats.parseRates /
 * ColumnSignature.parseBuckets (kept separate from `token` so the token
 * string itself, e.g. containing "/", is never relied on as an object key).
 */
export const DATE_FORMAT_CANDIDATES = [
  { key: "parse_date_iso", token: "YYYY-MM-DD" },
  { key: "parse_date_dmy", token: "DD/MM/YYYY" },
  { key: "parse_date_mdy", token: "MM/DD/YYYY" },
  { key: "parse_date_ymd_slash", token: "YYYY/MM/DD" },
] as const;

/** Coercion parse-rate stats computed for every text column, independent of date-format guessing. */
export const COERCION_PARSE_KEYS = ["to_number", "to_integer", "to_boolean", "to_date"] as const;

/** Every key ColumnStats.parseRates / ColumnSignature.parseBuckets carries when a column is a text column. */
export const PARSE_STAT_KEYS = [...COERCION_PARSE_KEYS, ...DATE_FORMAT_CANDIDATES.map((c) => c.key)] as const;
export type ParseStatKey = (typeof PARSE_STAT_KEYS)[number];

export const MAX_EXAMPLE_VALUES = 3;
export const MAX_EXAMPLE_VALUE_CHARS = 50;

export const ParseRateStat = z.object({
  attempted: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  /** At most MAX_EXAMPLE_VALUES, each truncated to MAX_EXAMPLE_VALUE_CHARS — the only raw sample data this profile ever stores. */
  failingExamples: z.array(z.string()),
});
export type ParseRateStat = z.infer<typeof ParseRateStat>;

export const ColumnStats = z.object({
  name: z.string(),
  /** Raw dialect-native type string from IntrospectResponse (contract.ts) — never normalized, same as introspection itself. */
  declaredType: z.string(),
  /** Distinct observed JS value shapes in the sample: "null" | "string" | "number" | "boolean" | "date" | "other". */
  observedTypes: z.array(z.string()),
  sampleCount: z.number().int().nonnegative(),
  nullCount: z.number().int().nonnegative(),
  emptyStringCount: z.number().int().nonnegative(),
  whitespaceOnlyCount: z.number().int().nonnegative(),
  distinctCount: z.number().int().nonnegative(),
  missingTokenCount: z.number().int().nonnegative(),
  /** All non-null, non-missing-token, non-blank values observed as JS strings — gates whether parseRates/minLength/maxLength are computed. */
  isTextColumn: z.boolean(),
  parseRates: z.record(z.enum(PARSE_STAT_KEYS), ParseRateStat).nullable(),
  /** Numeric/date columns: min/max value (as number, or ISO-8601 date string). Null when neither applies. */
  min: z.union([z.number(), z.string()]).nullable(),
  max: z.union([z.number(), z.string()]).nullable(),
  /** Text columns only. */
  minLength: z.number().int().nonnegative().nullable(),
  maxLength: z.number().int().nonnegative().nullable(),
});
export type ColumnStats = z.infer<typeof ColumnStats>;

/**
 * Coarse per-column signature (Step 3C). Deliberately drops every exact
 * count from ColumnStats — profile_hash below is computed purely from
 * this shape so adding more same-shape rows never changes the hash, only
 * a genuine shape change (e.g. a column's first unparseable value) does.
 */
export const ColumnSignature = z.object({
  name: z.string(),
  declaredType: z.string(),
  nullPresence: z.enum(["none", "some", "all"]),
  missingTokenPresence: z.enum(["yes", "no"]),
  /** Null when the column isn't a text column (no parse funcs run). */
  parseBuckets: z.record(z.enum(PARSE_STAT_KEYS), z.enum(["all", "some", "none"])).nullable(),
});
export type ColumnSignature = z.infer<typeof ColumnSignature>;

export const SampleMethod = z.enum(["keyset-head-tail", "full-table", "no-key-scan"]);
export type SampleMethod = z.infer<typeof SampleMethod>;

/** Worker job return value (apps/worker/src/lib/profile/profileEntity.ts) — apps/api persists this into source_profiles, the worker itself never writes to Postgres (no live JWT; same no-persistence-in-worker shape as check_run/preview_run/mappings_propose, see apps/worker/src/index.ts's header comment). */
export const EntityProfile = z.object({
  sampleMethod: SampleMethod,
  sampleSize: z.number().int().nonnegative(),
  columns: z.array(ColumnStats),
  signature: z.array(ColumnSignature),
  profileHash: z.string(),
  /** ISO-8601, set by the worker at computation time. */
  profiledAt: z.string(),
});
export type EntityProfile = z.infer<typeof EntityProfile>;
