import type { ConnectorManifest } from "../manifest.js";

/**
 * Slice R1 — generic "HTTPS endpoint" destination: an address plus one of
 * four sign-in methods. Destination only, and deliberately has no
 * platform-side Test/Browse at all (requirement 2) — connections.ts's
 * testConnection() special-cases this manifest id to return a canned
 * "checked when a job is published" result instead of dispatching, and
 * getConnectionSchema() special-cases it to return an empty entity list so
 * the mapping editor falls back to manual target-field entry.
 *
 * All four auth-method secret fields are declared non-required here since
 * only the one matching `authMethod` is ever actually filled in — the web
 * form (ConnectionForm.tsx) is responsible for only showing/collecting the
 * fields relevant to the selected method; splitFields()/splitFieldsForEdit()
 * only route whatever is actually present in `fields` to config vs. secret,
 * so leaving the other three blank is harmless (they're simply omitted,
 * same as any other optional field).
 */
export const httpsEndpointManifest: ConnectorManifest = {
  id: "https-endpoint",
  name: "HTTPS endpoint",
  version: "0.0.1",
  category: "server",
  auth: { method: "credentials" },
  configSchema: [
    { key: "address", label: "Address", type: "text", required: true, placeholder: "https://example.com/webhook", secret: false },
    {
      key: "authMethod",
      label: "Sign-in method",
      type: "select",
      required: true,
      secret: false,
      options: [
        { label: "None", value: "none" },
        { label: "Bearer token", value: "bearer" },
        { label: "API key header", value: "apiKey" },
        { label: "Username and password", value: "basic" },
      ],
    },
    { key: "apiKeyHeaderName", label: "API key header name", type: "text", required: false, placeholder: "X-Api-Key", secret: false },
    { key: "bearerToken", label: "Bearer token", type: "password", required: false, secret: true },
    { key: "apiKeyValue", label: "API key value", type: "password", required: false, secret: true },
    { key: "username", label: "Username", type: "text", required: false, secret: true },
    { key: "password", label: "Password", type: "password", required: false, secret: true },
  ],
  operations: ["push_dataset"],
  capabilities: ["etl_sink"],
  service: { host: "agent-bridge", port: 4041 },
};
