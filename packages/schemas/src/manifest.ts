import { z } from "zod";

/**
 * Connector manifests — the single source of truth for what a tool type is.
 * Adding tool N+1 to Nia = one manifest entry + one service image.
 * Zero frontend or worker changes.
 */

export const ConnectorCategory = z.enum([
  "database",
  "server",
  "product",
  "ai_vector",
  "bi",
  "files",
]);
export type ConnectorCategory = z.infer<typeof ConnectorCategory>;

export const AuthMethod = z.enum(["credentials", "oauth"]);
export type AuthMethod = z.infer<typeof AuthMethod>;

/** Verbs a node can perform. Write verbs are locked behind write grants. */
export const Operation = z.enum([
  "read",
  "insert",
  "update",
  "delete",
  "push_dataset",
]);
export type Operation = z.infer<typeof Operation>;

export const WRITE_OPERATIONS: readonly Operation[] = [
  "insert",
  "update",
  "delete",
  "push_dataset",
];

/** What a tool type can participate in. `triggers` and `mcp_tool` are reserved. */
export const Capability = z.enum([
  "queryable",
  "actions",
  "etl_source",
  "etl_sink",
  "triggers",
  "mcp_tool",
]);
export type Capability = z.infer<typeof Capability>;

/** One field in the credential/config form, rendered schema-driven in the Connect step. */
export const ConfigField = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "password", "number", "boolean", "select"]),
  required: z.boolean().default(true),
  placeholder: z.string().optional(),
  options: z
    .array(z.object({ label: z.string(), value: z.string() }))
    .optional(),
  /** Marks fields whose values go to Vault, never to app Postgres. */
  secret: z.boolean().default(false),
});
export type ConfigField = z.infer<typeof ConfigField>;

export const ConnectorManifest = z.object({
  /** e.g. "mysql", "mongodb", "supabase", "powerbi", "files" */
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  /** Ships with the service image — a manifest can never outlive its service. */
  version: z.string(),
  category: ConnectorCategory,
  auth: z.object({ method: AuthMethod }),
  configSchema: z.array(ConfigField),
  /**
   * Control verbs this connector supports. Read/write-ness is not re-declared
   * per entry — it's inherent to the verb itself, see WRITE_OPERATIONS below.
   */
  operations: z.array(Operation).nonempty(),
  capabilities: z.array(Capability).nonempty(),
  /** Internal Docker network address for dispatch, e.g. connector-mysql:4010 */
  service: z.object({
    host: z.string(),
    port: z.number().int().positive(),
  }),
});
export type ConnectorManifest = z.infer<typeof ConnectorManifest>;
