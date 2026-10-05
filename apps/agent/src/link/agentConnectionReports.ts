import { defaultHomeDir } from "../config/paths.js";
import { loadConfig } from "../config/store.js";
import type { AgentConnectionReport } from "./transport.js";

/**
 * Slice C1 — the per-check-in summary of every locally-defined
 * connection, used by the platform's `sqlserver_agent` connection
 * picker. Exactly these fields travel to the platform (the allow-list
 * the bridge's `AgentConnectionEntry` zod schema also enforces) — never
 * host/user/password. All connections configured on this agent build
 * are SQL Server today (`connectionCommands.ts`'s `addConnection`), so
 * `dialect` is always `"mssql"`.
 */
export function buildAgentConnectionReports(dir = defaultHomeDir()): AgentConnectionReport[] {
  return loadConfig(dir).connections.map((connection) => ({
    id: connection.id,
    name: connection.label,
    database: connection.sqlserver.database,
    dialect: "mssql",
  }));
}
