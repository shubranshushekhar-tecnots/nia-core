import type { ConnectorManifest } from "../manifest.js";
import { mongodbManifest } from "./mongodb.js";
import { mysqlManifest } from "./mysql.js";
import { postgresManifest } from "./postgres.js";
import { supabaseManifest } from "./supabase.js";

/**
 * The full set of installable connectors — one entry per manifest. Adding a
 * connector is one entry here (plus the manifest file + service image), per
 * manifest.ts's "zero frontend or worker changes" goal. Keyed by manifest id
 * so route/service code can validate a connector_id and look up dispatch
 * details (service host/port, configSchema) in one place.
 */
export const CONNECTOR_MANIFESTS: Record<string, ConnectorManifest> = {
  [mysqlManifest.id]: mysqlManifest,
  [mongodbManifest.id]: mongodbManifest,
  [supabaseManifest.id]: supabaseManifest,
  [postgresManifest.id]: postgresManifest,
};

export function getConnectorManifest(connectorId: string): ConnectorManifest | undefined {
  return CONNECTOR_MANIFESTS[connectorId];
}
