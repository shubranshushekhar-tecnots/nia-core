import type { IntrospectResponse } from "@nia/schemas";

/**
 * Maps a resolved connection's manifest id to the query-generation dialect.
 * Mirrors @nia/guardrails' GUARDRAIL_REGISTRY key space exactly (mysql /
 * mongodb / supabase) — supabase's underlying dialect is postgres.
 */
export type ChatDialect = "mysql" | "postgres" | "mongo";

export function dialectForConnector(connectorId: string): ChatDialect {
  switch (connectorId) {
    case "mysql":
      return "mysql";
    case "supabase":
      return "postgres";
    case "mongodb":
      return "mongo";
    default:
      throw new Error(`No chat dialect mapping for connector "${connectorId}".`);
  }
}

/** Compact, LLM-friendly rendering of an /introspect response. */
export function formatSchemaForPrompt(schema: IntrospectResponse): string {
  return schema.entities
    .map((e) => {
      const fields = e.fields.map((f) => `${f.name}: ${f.type}`).join(", ");
      return `- ${e.namespace}.${e.name} (${fields})`;
    })
    .join("\n");
}
