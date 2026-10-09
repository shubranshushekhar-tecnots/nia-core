import { testSqlLoginAndListDatabases, testSqlLoginWithAutoRetry, type SqlLoginTestInput } from "../../core/sqlLogin.js";
import { addConnection, ConnectionInUseError, InvalidTimeZoneError, listConnections, removeConnection, type AddConnectionInput } from "../../core/connections.js";
import { findConnection, loadConfig } from "../../config/store.js";
import { loadOrCreateMasterKey } from "../../secrets/keyfile.js";
import { LocalSecretStore } from "../../secrets/store.js";
import { ApiError, BadRequestError, NotFoundError } from "../errors.js";
import { RateLimiter } from "../rateLimit.js";
import type { LocalApiDeps } from "../deps.js";
import type { RouteDefinition } from "../router.js";

const CONNECTION_TEST_RATE_LIMIT = new RateLimiter(20, 60_000);
/** Separate instance from `CONNECTION_TEST_RATE_LIMIT` -- a client hammering one of these two raw-credentials endpoints shouldn't exhaust the other's budget. */
const DATABASES_LIST_RATE_LIMIT = new RateLimiter(20, 60_000);

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new BadRequestError(`${field} is required`);
  return value;
}

/** Shared by `POST /connections/test` and `POST /databases/list` — same optional fields either way. */
function parseSqlLoginInput(body: Record<string, unknown>): SqlLoginTestInput {
  return {
    host: requireString(body.host, "host"),
    user: requireString(body.user, "user"),
    password: requireString(body.password, "password"),
    instanceName: typeof body.instanceName === "string" ? body.instanceName : undefined,
    port: typeof body.port === "number" ? body.port : undefined,
    encrypt: typeof body.encrypt === "boolean" ? body.encrypt : undefined,
    trustServerCertificate: typeof body.trustServerCertificate === "boolean" ? body.trustServerCertificate : undefined,
    allowLegacyTls: typeof body.allowLegacyTls === "boolean" ? body.allowLegacyTls : undefined,
  };
}

export function buildConnectionsRoutes(deps: LocalApiDeps): RouteDefinition[] {
  return [
    {
      method: "POST",
      path: "/connections/test",
      rateLimiter: CONNECTION_TEST_RATE_LIMIT,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const input = parseSqlLoginInput(body);
        const pickedInstanceLoginMode = typeof body.pickedInstanceLoginMode === "number" ? body.pickedInstanceLoginMode : undefined;
        const { result, autoTrustedCertificate, autoAllowedLegacyTls } = await testSqlLoginWithAutoRetry(
          testSqlLoginAndListDatabases,
          input,
          pickedInstanceLoginMode,
        );
        return { ...result, autoTrustedCertificate, autoAllowedLegacyTls };
      },
    },
    {
      // Saved-connection only -- a connectionId is just an opaque id, never
      // a credential, so it's fine here. Raw credentials must never travel
      // in a URL (query strings end up in proxy/server logs and browser
      // history) -- use `POST /databases/list` for those instead.
      method: "GET",
      path: "/databases",
      handler: async (ctx) => {
        const connectionId = ctx.query.get("connectionId");
        if (!connectionId) throw new BadRequestError("connectionId is required -- use POST /databases/list to list databases for raw credentials");

        const config = loadConfig(deps.dir);
        const entry = findConnection(config, connectionId);
        if (!entry) throw new NotFoundError(`no connection with id ${JSON.stringify(connectionId)}`);

        const masterKey = loadOrCreateMasterKey(deps.dir);
        const secrets = new LocalSecretStore(masterKey, deps.dir);
        const credentials = secrets.get<{ user: string; password: string }>(entry.credentialRef);
        if (!credentials) throw new ApiError(500, "internal", `credentials for ${connectionId} are missing from the secret store`);

        return testSqlLoginAndListDatabases({
          host: entry.sqlserver.host,
          port: entry.sqlserver.port,
          instanceName: entry.sqlserver.instanceName,
          user: credentials.user,
          password: credentials.password,
          encrypt: entry.sqlserver.encrypt,
          allowLegacyTls: entry.sqlserver.allowLegacyTls,
          trustServerCertificate: entry.sqlserver.trustServerCertificate,
        });
      },
    },
    {
      // Raw-credentials counterpart to the GET above -- POST so the
      // credentials travel in the body, never in a URL/query string.
      method: "POST",
      path: "/databases/list",
      rateLimiter: DATABASES_LIST_RATE_LIMIT,
      handler: async (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        return testSqlLoginAndListDatabases(parseSqlLoginInput(body));
      },
    },
    {
      method: "POST",
      path: "/connections",
      handler: (ctx) => {
        const body = (ctx.body ?? {}) as Record<string, unknown>;
        const input: AddConnectionInput = {
          id: requireString(body.id, "id"),
          label: requireString(body.label, "label"),
          host: requireString(body.host, "host"),
          database: requireString(body.database, "database"),
          user: requireString(body.user, "user"),
          password: requireString(body.password, "password"),
          sourceTimeZone: requireString(body.sourceTimeZone, "sourceTimeZone"),
          port: typeof body.port === "number" ? body.port : undefined,
          instanceName: typeof body.instanceName === "string" ? body.instanceName : undefined,
          encrypt: typeof body.encrypt === "boolean" ? body.encrypt : undefined,
          allowLegacyTls: typeof body.allowLegacyTls === "boolean" ? body.allowLegacyTls : undefined,
          trustServerCertificate: typeof body.trustServerCertificate === "boolean" ? body.trustServerCertificate : undefined,
        };
        try {
          return addConnection(input, deps.dir);
        } catch (err) {
          if (err instanceof InvalidTimeZoneError) throw new BadRequestError(err.message);
          throw err;
        }
      },
    },
    {
      method: "GET",
      path: "/connections",
      handler: () => ({ connections: listConnections(deps.dir) }),
    },
    {
      method: "DELETE",
      path: "/connections/:id",
      handler: (ctx) => {
        try {
          const removed = removeConnection(ctx.params.id!, deps.dir);
          if (!removed) throw new NotFoundError(`no connection with id ${JSON.stringify(ctx.params.id)}`);
          return { removed: true };
        } catch (err) {
          if (err instanceof ConnectionInUseError) {
            throw new ApiError(409, "inUse", err.message);
          }
          throw err;
        }
      },
    },
  ];
}
