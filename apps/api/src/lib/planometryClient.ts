import type { IntrospectResponse } from "@nia/schemas";

/**
 * Slice R1, requirement 1 — apps/api's own direct client for Planometry's
 * v4 Internal Table wire contract (docs/planometry/connector-guide-v4.md
 * §2.1-§2.2), mirroring apps/agent/src/planometry/{client,types}.ts's
 * request/response shapes exactly (read there only as reference — never
 * imported, since apps/agent is owned by a different slice of work).
 *
 * Unlike every other connector, this is called directly by apps/api
 * (connections.ts's testConnection/getConnectionSchema), never dispatched
 * through connectorDispatch.ts's signed internal-service contract —
 * "the platform calls Planometry's connection check directly" (requirement
 * 1) means apps/api's own outbound HTTPS call to the 3rd-party API, not an
 * internal microservice round trip.
 */

type ColumnType = "Text" | "Number" | "Date" | "DateTime" | "Boolean";

type SchemaColumn = { name: string; type: ColumnType; isKey: boolean };

type TableSchema = {
  dataSourceId: string;
  dataSourceName: string;
  columns: SchemaColumn[];
  keyColumns: string[];
};

type ResponseEnvelope<T> = { success: boolean; message?: string; data?: T };

const TEST_TIMEOUT_MS = 15_000;
const INTROSPECT_TIMEOUT_MS = 60_000;

async function jsonRequest<T>(url: string, pushKey: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${pushKey}`, "content-type": "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === "AbortError"
        ? `Planometry request timed out after ${timeoutMs}ms.`
        : `Could not reach Planometry: ${err instanceof Error ? err.message : String(err)}`;
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  if (res.status === 401 || res.status === 404) {
    throw new Error("Wrong or regenerated push key, or the table was deleted.");
  }
  if (res.status >= 500) throw new Error(`Planometry returned ${res.status}.`);

  let envelope: ResponseEnvelope<T>;
  try {
    envelope = text ? (JSON.parse(text) as ResponseEnvelope<T>) : { success: res.status < 300 };
  } catch {
    throw new Error(`Planometry returned a non-JSON response (status ${res.status}).`);
  }
  if (res.status === 400 || !envelope.success) {
    throw new Error(envelope.message ?? `Planometry rejected the request (status ${res.status}).`);
  }
  if (res.status >= 300) throw new Error(`Planometry returned ${res.status}.`);

  return envelope.data as T;
}

/** GET {address} — Planometry's connection check (guide §2.1). */
export async function checkPlanometryConnection(
  address: string,
  pushKey: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const start = Date.now();
  try {
    await jsonRequest(address, pushKey, TEST_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** GET {address}/schema -> the standard IntrospectResponse shape (guide §2.2). */
export async function getPlanometrySchema(
  address: string,
  pushKey: string,
): Promise<{ ok: true; value: IntrospectResponse } | { ok: false; error: string }> {
  try {
    const schema = await jsonRequest<TableSchema>(`${address}/schema`, pushKey, INTROSPECT_TIMEOUT_MS);
    const keyColumns = new Set(schema.keyColumns);
    const value: IntrospectResponse = {
      entities: [
        {
          namespace: "planometry",
          name: schema.dataSourceName || schema.dataSourceId,
          fields: schema.columns.map((col) => ({ name: col.name, type: col.type })),
          // Single-column verified-unique key, same convention as every
          // other connector's introspect (contract.ts's primaryKey doc) —
          // null if zero or more than one key column is reported.
          primaryKey: keyColumns.size === 1 ? schema.columns.find((col) => col.isKey)!.name : null,
        },
      ],
    };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
