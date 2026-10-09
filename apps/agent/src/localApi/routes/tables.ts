import { UnknownTableError } from "@nia/extract";
import { listColumns, listTables, previewTable, type SqlCredentials } from "../../core/tableBrowser.js";
import { findConnection, loadConfig } from "../../config/store.js";
import type { ConnectionEntry } from "../../config/types.js";
import { loadOrCreateMasterKey } from "../../secrets/keyfile.js";
import { LocalSecretStore } from "../../secrets/store.js";
import { ApiError, NotFoundError } from "../errors.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

function loadConnectionAndCredentials(dir: string, connectionId: string): { entry: ConnectionEntry; credentials: SqlCredentials } {
  const config = loadConfig(dir);
  const entry = findConnection(config, connectionId);
  if (!entry) throw new NotFoundError(`no connection with id ${JSON.stringify(connectionId)}`);

  const masterKey = loadOrCreateMasterKey(dir);
  const secrets = new LocalSecretStore(masterKey, dir);
  const credentials = secrets.get<SqlCredentials>(entry.credentialRef);
  if (!credentials) throw new ApiError(500, "internal", `credentials for ${connectionId} are missing from the secret store`);

  return { entry, credentials };
}

/** `UnknownTableError` (from `@nia/extract`'s `resolveTable`) means the caller's `:table` doesn't exactly match the live catalog -- reported as a 404, same as an unknown connection id. */
async function withUnknownTableAs404<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof UnknownTableError) throw new NotFoundError(err.message);
    throw err;
  }
}

export function buildTablesRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/connections/:id/tables",
      handler: async (ctx) => {
        const { entry, credentials } = loadConnectionAndCredentials(deps.dir, ctx.params.id!);
        return { tables: await listTables(entry, credentials) };
      },
    },
    {
      method: "GET",
      path: "/connections/:id/tables/:table/columns",
      handler: async (ctx) => {
        const { entry, credentials } = loadConnectionAndCredentials(deps.dir, ctx.params.id!);
        return { columns: await withUnknownTableAs404(() => listColumns(entry, credentials, ctx.params.table!)) };
      },
    },
    {
      method: "GET",
      path: "/connections/:id/tables/:table/preview",
      handler: async (ctx) => {
        const { entry, credentials } = loadConnectionAndCredentials(deps.dir, ctx.params.id!);
        const limitParam = ctx.query.get("limit");
        const limit = limitParam ? Number(limitParam) : undefined;
        return withUnknownTableAs404(() => previewTable(entry, credentials, ctx.params.table!, limit ?? 50));
      },
    },
  ];
}
