import type { CatalogTable } from "@nia/extract";
import { defaultHomeDir } from "../config/paths.js";
import { findConnection, findJob, loadConfig, saveConfig, upsertJob } from "../config/store.js";
import type { ConnectionEntry, DeleteMode, HttpsAuthMethod, JobMappingColumn, JobStrategy, SyncJobEntry } from "../config/types.js";
import { isDestinationHostAllowed } from "../destinations/allowedHosts.js";
import { validateHttpsAddress } from "../destinations/httpsAddress.js";
import {
  buildTargetSchemaSnapshot,
  columnTypesOf,
  describeError,
  DEFAULT_MAX_DELETE_PERCENT,
  readSourceTable,
  removeJob,
  validateDeleteMode,
  validateRealtimeIntervals,
  validateUpsertDelta,
} from "../cli/jobCommands.js";
import { buildHttpsMapping, buildMapping, type RawMappingPair } from "../cli/jobMapping.js";
import type { Logger } from "../ops/logger.js";
import { PlanometryClient } from "../planometry/client.js";
import { resolveJobFilter, type JobFilterCondition } from "../planometry/parameters.js";
import type { TableSchema } from "../planometry/types.js";
import { loadOrCreateMasterKey } from "../secrets/keyfile.js";
import { LocalSecretStore } from "../secrets/store.js";
import { InvalidCronScheduleError, validateCronExpression } from "../scheduler/cronSchedule.js";
import type { CheckInSetupSummary } from "./transport.js";
import type { FetchedSetup, PublishedJobSetup, SetupFilterCondition } from "./setupClient.js";

/**
 * The subset of `SetupClient`'s public surface `SetupManager` actually
 * calls — kept as a structural interface (rather than importing the
 * `SetupClient` class as a type) so a test's fake client can be a plain
 * object literal: `SetupClient` has private fields, which would make it
 * impossible to satisfy from outside link/setupClient.ts.
 */
export interface SetupClientLike {
  fetchSetup(setupId: string): Promise<FetchedSetup>;
  fetchSecret(setupId: string): Promise<Record<string, unknown>>;
  reportApplied(setupId: string, appliedVersion: number): Promise<void>;
  reportRejected(setupId: string, rejectionReason: string): Promise<void>;
}

/**
 * Converts a platform-published filter (`SetupFilterCondition[]`, the flat
 * FilterCondition shape from packages/schemas/src/nodeConfig.ts) into this
 * agent's own `JobFilterCondition[]` (planometry/parameters.ts). Two things
 * have no local equivalent and are refused outright rather than silently
 * dropped: the "contains" operator, and `caseInsensitive: true` on any
 * operator (the agent's filter has no case-folding concept at all).
 */
function convertSetupFilter(filter: SetupFilterCondition[]): { ok: true; filter: JobFilterCondition[] } | { ok: false; error: string } {
  const out: JobFilterCondition[] = [];
  for (const cond of filter) {
    if (cond.caseInsensitive) {
      return { ok: false, error: `filter on "${cond.field}": case-insensitive matching is not supported by the agent` };
    }
    if (cond.operator === "is_null") {
      out.push({ column: cond.field, operator: "isNull" });
      continue;
    }
    if (cond.operator === "is_not_null") {
      out.push({ column: cond.field, operator: "isNotNull" });
      continue;
    }
    if (cond.operator === "contains") {
      return { ok: false, error: `filter on "${cond.field}": operator "contains" is not supported by the agent` };
    }
    if (cond.value === undefined) {
      return { ok: false, error: `filter on "${cond.field}": operator "${cond.operator}" requires a value` };
    }
    out.push({ column: cond.field, operator: cond.operator, value: cond.value });
  }
  return { ok: true, filter: out };
}

/** Narrows an unknown destination-config value to `HttpsAuthMethod`, rather than trusting the platform's payload blindly. */
function asHttpsAuthMethod(value: unknown): HttpsAuthMethod | undefined {
  return value === "none" || value === "bearer" || value === "apiKey" || value === "basic" ? value : undefined;
}

type ApplyResult = { ok: true } | { ok: false; error: string };
type BuildResult = { ok: true; job: SyncJobEntry } | { ok: false; error: string };

/** Everything the two destination-specific builders need, already fetched/validated by `apply()`'s shared pipeline. */
interface BuildJobContext {
  setup: CheckInSetupSummary;
  published: PublishedJobSetup;
  connection: ConnectionEntry;
  table: CatalogTable;
  /** The validated, allow-listed destination address — becomes the job's `targetUrl`. */
  targetUrl: string;
  /** `fetched.destination.config` — non-secret destination fields (e.g. https's `authMethod`/`apiKeyHeaderName`). */
  destinationConfig: Record<string, unknown>;
  filter: JobFilterCondition[];
  params: Record<string, string>;
  /** `fetched destination secret` — never logged, never stored verbatim (only the field(s) the destination actually needs). */
  secret: Record<string, unknown>;
  secrets: LocalSecretStore;
  /** Preserves a previously-applied job's name across a re-apply; otherwise synthesized from the workflow id. */
  name: string;
}

export interface SetupManagerOptions {
  setupClient: SetupClientLike;
  logger?: Logger;
  dir?: string;
}

/**
 * Slice R3b (docs/plans/agent-canvas-integration.md B.4/B.7/B.10): applies
 * (or removes) the platform-published job setups listed on every check-in
 * response (`CheckInResponse.setups`). Intended to be called fire-and-
 * forget from agentLoop.ts's `CheckInLoop` `onSuccess` (never awaited
 * there, per item 3's "applying never delays the scheduler") —
 * `handleCheckIn` isolates each setup's failure from every other (item 3's
 * "one setup failing to apply never affects another setup or any running
 * job") and never throws itself.
 */
export class SetupManager {
  private readonly setupClient: SetupClientLike;
  private readonly logger?: Logger;
  private readonly dir: string;
  /**
   * In-memory only, process lifetime — "do not retry that same version"
   * (item 1's last bullet). Reset on agent restart, which is acceptable: a
   * still-broken setup is simply rejected again with the same reason on
   * the next check-in after a restart, not retried in a tight loop.
   */
  private readonly rejectedVersions = new Map<string, number>();

  constructor(options: SetupManagerOptions) {
    this.setupClient = options.setupClient;
    this.logger = options.logger;
    this.dir = options.dir ?? defaultHomeDir();
  }

  async handleCheckIn(setups: CheckInSetupSummary[]): Promise<void> {
    for (const setup of setups) {
      try {
        await this.handleOne(setup);
      } catch (err) {
        // Item 3: a bug/unexpected throw handling one setup must never stop the rest.
        this.logger?.warn("setup_apply_unexpected_error", { setupId: setup.id, error: describeError(err) });
      }
    }
  }

  private async handleOne(setup: CheckInSetupSummary): Promise<void> {
    const config = loadConfig(this.dir);
    const existingJob = findJob(config, setup.id);

    if (setup.removed) {
      if (existingJob) {
        await removeJob(setup.id, this.dir, { allowPlatformManaged: true });
        this.logger?.info("setup_removed", { setupId: setup.id });
      }
      this.rejectedVersions.delete(setup.id);
      return;
    }

    const appliedVersion = existingJob?.platformManaged?.appliedVersion ?? 0;
    if (setup.wantedVersion <= appliedVersion) return;
    if (this.rejectedVersions.get(setup.id) === setup.wantedVersion) return;

    const result = await this.apply(setup, existingJob);
    if (result.ok) {
      this.rejectedVersions.delete(setup.id);
      this.logger?.info("setup_applied", { setupId: setup.id, appliedVersion: setup.wantedVersion });
      await this.setupClient.reportApplied(setup.id, setup.wantedVersion);
    } else {
      this.rejectedVersions.set(setup.id, setup.wantedVersion);
      this.logger?.warn("setup_rejected", { setupId: setup.id, wantedVersion: setup.wantedVersion, reason: result.error });
      await this.setupClient.reportRejected(setup.id, result.error);
    }
  }

  /**
   * Runs the same checks `job add` runs (host allow-list first, then
   * local connection, then source table/columns, then mapping/types —
   * item 1's ordered list), fetching the destination secret only once
   * the cheaper checks have passed, and on success saves the job
   * (marked platform-managed) and the secret. Never throws — every
   * failure path returns `{ ok: false, error }` with a short, plain,
   * secret-free reason (item 1's "never a secret or a data value").
   */
  private async apply(setup: CheckInSetupSummary, existingJob: SyncJobEntry | undefined): Promise<ApplyResult> {
    let fetched: FetchedSetup;
    try {
      fetched = await this.setupClient.fetchSetup(setup.id);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
    const published = fetched.setup;
    if (!published) return { ok: false, error: "setup has no job definition" };
    if (!fetched.localSourceConnectionId) return { ok: false, error: "no local source connection is linked to this setup" };

    const config = loadConfig(this.dir);
    const connection = findConnection(config, fetched.localSourceConnectionId);
    if (!connection) return { ok: false, error: `local connection ${fetched.localSourceConnectionId} was not found` };

    const connectorId = fetched.destination.connectorId;
    const isHttps = connectorId === "https-endpoint";
    const isPlanometry = connectorId === "planometry-table";
    if (!isHttps && !isPlanometry) return { ok: false, error: `unsupported destination connector "${connectorId}"` };

    const address = fetched.destination.config.address;
    if (typeof address !== "string") return { ok: false, error: "destination has no address" };

    // Item 1's check order: host allow-list, then local connection (above), then source table/columns (below), then mapping/types.
    const addressCheck = validateHttpsAddress(address);
    if (!addressCheck.ok) return { ok: false, error: addressCheck.error };
    if (!isDestinationHostAllowed(addressCheck.url.host, this.dir)) {
      return { ok: false, error: `destination host "${addressCheck.url.host}" is not on the local allow-list` };
    }

    const catalogResult = await readSourceTable(connection, published.sourceTable, this.dir);
    if (!catalogResult.ok) return { ok: false, error: catalogResult.error };

    const filterResult = convertSetupFilter(published.filter);
    if (!filterResult.ok) return { ok: false, error: filterResult.error };
    const filter = filterResult.filter;
    const params = published.params ?? {};
    try {
      resolveJobFilter(filter, columnTypesOf(catalogResult.table), params, undefined, connection.sourceTimeZone);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }

    for (const schedule of [published.schedule, published.replaceSchedule]) {
      if (schedule === undefined) continue;
      try {
        validateCronExpression(schedule);
      } catch (err) {
        if (err instanceof InvalidCronScheduleError) return { ok: false, error: err.message };
        throw err;
      }
    }

    const strategy: JobStrategy = published.mode;
    if (isHttps && strategy === "realtime") return { ok: false, error: 'destinationType "https" does not support strategy "realtime"' };
    const deleteMode: DeleteMode | undefined = published.deleteMode;
    if (isHttps && deleteMode !== undefined && deleteMode !== "none") {
      return { ok: false, error: `destinationType "https" does not support deleteMode "${deleteMode}"` };
    }

    let secret: Record<string, unknown>;
    try {
      secret = await this.setupClient.fetchSecret(setup.id);
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }

    const masterKey = loadOrCreateMasterKey(this.dir);
    const secrets = new LocalSecretStore(masterKey, this.dir);

    const ctx: BuildJobContext = {
      setup,
      published,
      connection,
      table: catalogResult.table,
      targetUrl: address,
      destinationConfig: fetched.destination.config,
      filter,
      params,
      secret,
      secrets,
      name: existingJob?.name ?? `platform setup ${fetched.workflowId}`,
    };

    const buildResult = isHttps ? await this.buildHttpsJob(ctx) : await this.buildPlanometryJob(ctx);
    if (!buildResult.ok) return buildResult;
    const job = buildResult.job;

    saveConfig(upsertJob(config, job), this.dir);
    // A changed field here changes the job's fingerprint (sync/watermark.ts's
    // computeJobFingerprint), so the next run naturally treats a stale saved
    // watermark as absent (item 1's last bullet) — nothing more to do here.
    if (existingJob?.pushKeyRef && existingJob.pushKeyRef !== job.pushKeyRef) secrets.delete(existingJob.pushKeyRef);

    return { ok: true };
  }

  /**
   * `destinationType: "https"` branch (mirrors cli/jobCommands.ts's
   * `addHttpsJob`): mapping is explicit-only, `targetSchemaSnapshot` is an
   * empty placeholder, and `strategy`/`deleteMode` refusals already
   * happened in `apply()` before the secret was even fetched. The sign-in
   * secret value lives under a different key per `authMethod` in the
   * fetched secret payload (`bearerToken`/`apiKeyValue`/`password`) —
   * `username` is secret there too (the https-endpoint connector manifest
   * marks it `secret: true`), unlike the local CLI's `job add --https`
   * flag which takes it as a plain argument; both end up in the same
   * place, the job's non-secret `https.username` field.
   */
  private async buildHttpsJob(ctx: BuildJobContext): Promise<BuildResult> {
    const { setup, published, connection, table, targetUrl, destinationConfig, filter, params, secret, secrets, name } = ctx;

    const mapOverrides: RawMappingPair[] = published.mapping;
    const mappingPlan = buildHttpsMapping(table, mapOverrides);
    if (mappingPlan.errors.length > 0) return { ok: false, error: mappingPlan.errors.join("; ") };

    const authMethod = asHttpsAuthMethod(destinationConfig.authMethod);
    if (!authMethod) return { ok: false, error: `destination has an invalid authMethod "${String(destinationConfig.authMethod)}"` };

    const headerName = typeof destinationConfig.apiKeyHeaderName === "string" ? destinationConfig.apiKeyHeaderName : undefined;
    if (authMethod === "apiKey" && !headerName) return { ok: false, error: 'https authMethod "apiKey" requires a headerName' };

    let username: string | undefined;
    let secretValue: string | undefined;
    if (authMethod === "bearer") {
      secretValue = typeof secret.bearerToken === "string" ? secret.bearerToken : undefined;
    } else if (authMethod === "apiKey") {
      secretValue = typeof secret.apiKeyValue === "string" ? secret.apiKeyValue : undefined;
    } else if (authMethod === "basic") {
      username = typeof secret.username === "string" ? secret.username : undefined;
      secretValue = typeof secret.password === "string" ? secret.password : undefined;
      if (!username) return { ok: false, error: 'https authMethod "basic" requires a username' };
    }
    if (authMethod !== "none" && !secretValue) return { ok: false, error: `https authMethod "${authMethod}" requires a secret` };

    const strategy: JobStrategy = published.mode;
    if (strategy === "upsertDelta") {
      const check = await validateUpsertDelta(
        strategy,
        connection,
        table,
        published.sourceTable,
        published.watermarkColumn,
        filter,
        params,
        published.replaceSchedule,
        this.dir,
      );
      if (!check.ok) return { ok: false, error: check.error };
    }

    const pushKeyRef = authMethod === "none" ? undefined : secrets.put({ secret: secretValue });

    const job: SyncJobEntry = {
      id: setup.id,
      name,
      connectionId: connection.id,
      sourceTable: published.sourceTable,
      targetUrl,
      pushKeyRef,
      destinationType: "https",
      https: {
        authMethod,
        headerName: authMethod === "apiKey" ? headerName : undefined,
        username: authMethod === "basic" ? username : undefined,
        rowsField: undefined,
      },
      strategy,
      mapping: mappingPlan.pairs,
      targetSchemaSnapshot: { columns: [], keyColumns: [] },
      onNullKey: "stop",
      allowEmptyReplace: false,
      filter,
      params,
      schedule: published.schedule,
      watermarkColumn: strategy === "upsertDelta" ? published.watermarkColumn : undefined,
      overlapSeconds: strategy === "upsertDelta" ? published.overlapSeconds : undefined,
      replaceSchedule: strategy === "upsertDelta" ? published.replaceSchedule : undefined,
      deleteMode: undefined,
      maxDeletePercent: undefined,
      softDeleteColumn: undefined,
      pollIntervalSeconds: undefined,
      reconciliationIntervalSeconds: undefined,
      platformManaged: { setupId: setup.id, appliedVersion: setup.wantedVersion },
    };

    return { ok: true, job };
  }

  /**
   * Default (Planometry) branch (mirrors cli/jobCommands.ts's `addJob`):
   * reads Planometry's live column layout via `PlanometryClient`, builds
   * the auto-matched mapping, and runs the same upsertDelta/deleteMode/
   * realtime checks `job add` runs.
   */
  private async buildPlanometryJob(ctx: BuildJobContext): Promise<BuildResult> {
    const { setup, published, connection, table, targetUrl, filter, params, secret, secrets, name } = ctx;

    const pushKey = secret.pushKey;
    if (typeof pushKey !== "string" || !pushKey) return { ok: false, error: "destination secret is missing a pushKey" };

    let schema: TableSchema;
    const client = new PlanometryClient({ tableUrl: targetUrl, pushKey });
    try {
      await client.checkConnection();
      schema = await client.getSchema();
    } catch (err) {
      return { ok: false, error: describeError(err) };
    } finally {
      await client.close();
    }

    const mapOverrides: RawMappingPair[] = published.mapping;
    const plan = buildMapping(table, schema.columns, schema.keyColumns, mapOverrides, connection.sourceTimeZone);
    if (plan.errors.length > 0) return { ok: false, error: plan.errors.join("; ") };

    const strategy: JobStrategy = published.mode;
    if (strategy === "upsertDelta" || strategy === "realtime") {
      const check = await validateUpsertDelta(
        strategy,
        connection,
        table,
        published.sourceTable,
        published.watermarkColumn,
        filter,
        params,
        published.replaceSchedule,
        this.dir,
      );
      if (!check.ok) return { ok: false, error: check.error };
    }

    const deleteModeCheck = validateDeleteMode(strategy, published.deleteMode, published.maxDeletePercent, published.softDeleteColumn, table);
    if (!deleteModeCheck.ok) return { ok: false, error: deleteModeCheck.error };

    let realtimeIntervals: { pollIntervalSeconds: number; reconciliationIntervalSeconds: number | undefined } | undefined;
    if (strategy === "realtime") {
      const check = validateRealtimeIntervals(published.pollIntervalSeconds, published.reconciliationIntervalSeconds, published.deleteMode);
      if (!check.ok) return { ok: false, error: check.error };
      realtimeIntervals = check;
    }

    const pairs: JobMappingColumn[] = plan.pairs;
    const pushKeyRef = secrets.put({ pushKey });

    const job: SyncJobEntry = {
      id: setup.id,
      name,
      connectionId: connection.id,
      sourceTable: published.sourceTable,
      targetUrl,
      pushKeyRef,
      strategy,
      mapping: pairs,
      targetSchemaSnapshot: buildTargetSchemaSnapshot(schema, pairs),
      onNullKey: "stop",
      allowEmptyReplace: false,
      filter,
      params,
      schedule: published.schedule,
      watermarkColumn: strategy === "upsertDelta" || strategy === "realtime" ? published.watermarkColumn : undefined,
      overlapSeconds: strategy === "upsertDelta" || strategy === "realtime" ? published.overlapSeconds : undefined,
      replaceSchedule: strategy === "upsertDelta" || strategy === "realtime" ? published.replaceSchedule : undefined,
      deleteMode: strategy === "upsertDelta" || strategy === "realtime" ? published.deleteMode : undefined,
      maxDeletePercent:
        (strategy === "upsertDelta" || strategy === "realtime") && published.deleteMode === "reconciliation"
          ? published.maxDeletePercent ?? DEFAULT_MAX_DELETE_PERCENT
          : undefined,
      softDeleteColumn:
        (strategy === "upsertDelta" || strategy === "realtime") && published.deleteMode === "softDelete" ? published.softDeleteColumn : undefined,
      pollIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.pollIntervalSeconds : undefined,
      reconciliationIntervalSeconds: strategy === "realtime" ? realtimeIntervals!.reconciliationIntervalSeconds : undefined,
      platformManaged: { setupId: setup.id, appliedVersion: setup.wantedVersion },
    };

    return { ok: true, job };
  }
}
