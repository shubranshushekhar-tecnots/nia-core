import { createHash } from "node:crypto";
import { PARSE_STAT_KEYS, type ColumnSignature, type ColumnStats } from "@nia/schemas";

/**
 * Phase 10 Step 3C — coarse signature + profile_hash. Derived purely from
 * ColumnStats (stats.ts), dropping every exact count so the hash is stable
 * across sample-count/row-count drift of the same shape (see this
 * function's own doc below) and only moves when a column's presence/parse
 * BUCKET actually changes — e.g. its first unparseable value flips a
 * parse function's bucket from "all" to "some".
 */

function bucket(passed: number, attempted: number): "all" | "some" | "none" {
  if (attempted === 0) return "none";
  if (passed === attempted) return "all";
  if (passed === 0) return "none";
  return "some";
}

export function computeColumnSignature(stats: ColumnStats): ColumnSignature {
  const nullPresence = stats.nullCount === 0 ? "none" : stats.nullCount === stats.sampleCount ? "all" : "some";
  const missingTokenPresence = stats.missingTokenCount > 0 ? "yes" : "no";

  let parseBuckets: ColumnSignature["parseBuckets"] = null;
  if (stats.isTextColumn && stats.parseRates) {
    const buckets: Partial<Record<(typeof PARSE_STAT_KEYS)[number], "all" | "some" | "none">> = {};
    for (const key of PARSE_STAT_KEYS) {
      const rate = stats.parseRates[key];
      if (!rate) continue;
      buckets[key] = bucket(rate.passed, rate.attempted);
    }
    parseBuckets = buckets as Record<(typeof PARSE_STAT_KEYS)[number], "all" | "some" | "none">;
  }

  return {
    name: stats.name,
    declaredType: stats.declaredType,
    nullPresence,
    missingTokenPresence,
    parseBuckets,
  };
}

export function computeSignature(columns: ColumnStats[]): ColumnSignature[] {
  return columns.map(computeColumnSignature);
}

/**
 * Canonical JSON: keys sorted (column order is already stable — same
 * introspection field order every run — but each object's own key order
 * is made explicit here rather than trusted, since JSON.stringify's key
 * order follows insertion order, and this function's own literal below IS
 * that insertion order — sorted alphabetically on purpose, not by
 * accident of how ColumnSignature happens to get built).
 */
function canonicalize(sig: ColumnSignature): Record<string, unknown> {
  return {
    declaredType: sig.declaredType,
    missingTokenPresence: sig.missingTokenPresence,
    name: sig.name,
    nullPresence: sig.nullPresence,
    parseBuckets: sig.parseBuckets
      ? Object.fromEntries(PARSE_STAT_KEYS.filter((k) => sig.parseBuckets![k] !== undefined).map((k) => [k, sig.parseBuckets![k]]))
      : null,
  };
}

export function computeProfileHash(signature: ColumnSignature[]): string {
  const canonical = signature.map(canonicalize);
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Phase 13, Step 6 — a coarser sibling of computeProfileHash: hashes only
 * a column's name+declaredType, dropping every value-shape signal
 * (nullPresence, missingTokenPresence, parseBuckets). CleanPlan's drift
 * check (runEtl.ts) compares this separately from profileHash so the
 * refusal message can distinguish "the table's columns changed" (this
 * hash) from "the same columns' data shape changed" (profileHash) — see
 * cleanPlan.ts's CleanPlanRecord doc comment.
 */
export function computeSchemaHash(columns: ColumnStats[]): string {
  const canonical = columns
    .map((c) => ({ name: c.name, declaredType: c.declaredType }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const json = JSON.stringify(canonical);
  return createHash("sha256").update(json).digest("hex");
}
