import type { Catalog } from "@nia/extract";
import { computeCatalogFingerprint } from "./catalogFingerprint.js";
import type { PlanometryClient } from "./client.js";

/**
 * Pushes the catalog at pairing (no `lastFingerprint` yet), on a
 * schema-fingerprint change, or when a poll response set
 * `catalogRequested` (Phase 2 §4). Returns the fingerprint to persist as
 * `ConnectionEntry.lastCatalogFingerprint` regardless of whether a push
 * happened, so the caller always has the current value on hand.
 */
export async function syncCatalogIfNeeded(
  client: PlanometryClient,
  connectionId: string,
  catalog: Catalog,
  lastFingerprint: string | undefined,
  catalogRequested: boolean,
): Promise<string> {
  const fingerprint = computeCatalogFingerprint(catalog);
  if (!catalogRequested && fingerprint === lastFingerprint) return fingerprint;
  await client.postCatalog({ connectionId, fingerprint, catalog });
  return fingerprint;
}
