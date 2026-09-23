/**
 * Diagnostic harness for the multi-source COUNT bug reported against
 * chat-smoke.ts's "multi-source count: reduced to 6 (3 employees x 2
 * sources)" assertion (scripts/chat-smoke.ts, mysql+mongodb case) —
 * occasionally reduces to 8 or 9 instead of 6.
 *
 * A wrong COUNT over seeded, fixed data is not flakiness — it means some
 * generated pipeline is actually wrong on that run. This script isolates
 * JUST that one question and runs it N times back to back (default 15),
 * capturing on EVERY run (not just failures):
 *   - the reduction plan (operation/targetField)
 *   - each source's executedQuery (SQL or Mongo pipeline, verbatim)
 *   - each source's raw rows/columns/rowCount/truncated
 *   - the final reduceOutcome
 * so a wrong run can be diffed against a correct one after the fact.
 *
 * Reuses chat-smoke.ts's exact seeding conventions (service-role Supabase
 * client, docker-compose service names/internal ports) — see that file's
 * header comment for the full host-vs-container-network rationale. Only
 * seeds mysql + mongodb (the two sources in the failing case).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/chat-count-diagnose.ts [N]
 * (N defaults to 15). Writes full per-run artifacts to
 *   /tmp/chat-count-diagnose-<timestamp>.jsonl
 * one JSON object per line, and prints a PASS/FAIL summary per run plus a
 * final tally. Same env/prereqs as chat-smoke.ts.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "ioredis";
import type { ChatStreamEvent } from "@nia/schemas";
import { buildMultiSourceGraph } from "../src/lib/chat/multiSource/graph.js";
import { channelFor } from "../src/lib/chat/publish.js";
import { env } from "../src/env.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;
type ConnectorId = keyof typeof SANDBOX;

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(orgId: string, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];

  const { count: installCount } = await supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connector_id", connectorId);
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ org_id: orgId, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-chat-smoke`;
  const { data: existing } = await supabase
    .from("connections")
    .select("id")
    .eq("org_id", orgId)
    .eq("handle", handle)
    .maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("connections")
      .update({ config: { host, port, database } })
      .eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  const { data: vaultRef, error: vaultError } = await supabase.rpc("create_connector_secret", {
    p_secret: { user, password },
  });
  if (vaultError || !vaultRef) throw new Error(`vault write for ${connectorId} failed: ${vaultError?.message}`);

  const { data, error } = await supabase
    .from("connections")
    .insert({
      org_id: orgId,
      owner_id: null,
      connector_id: connectorId,
      handle,
      display_name: `Chat smoke (${connectorId})`,
      owner_user_id: DEMO_USER_ID,
      config: { host, port, database },
      vault_secret_ref: vaultRef as string,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`connection insert for ${connectorId} failed: ${error?.message}`);
  return data.id as string;
}

function collectEvents(orgId: string, jobId: string): { events: ChatStreamEvent[]; close: () => Promise<void> } {
  const client = new Redis(env.REDIS_URL);
  const channel = channelFor(orgId, jobId);
  const events: ChatStreamEvent[] = [];
  client.subscribe(channel);
  client.on("message", (receivedChannel, raw) => {
    if (receivedChannel !== channel) return;
    events.push(JSON.parse(raw) as ChatStreamEvent);
  });
  return {
    events,
    close: async () => {
      await client.unsubscribe(channel).catch(() => undefined);
      client.disconnect();
    },
  };
}

async function main(): Promise<void> {
  const N = Number(process.argv[2] ?? 15);
  const artifactPath = `/tmp/chat-count-diagnose-${Date.now()}.jsonl`;

  log("=== SEEDING ===");
  const orgId = await getOrgId();
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection(orgId, "mysql"),
    mongodb: await seedConnection(orgId, "mongodb"),
  };
  log(`Seeded connections: ${JSON.stringify(connectionIds)}`);
  log(`Writing per-run artifacts to ${artifactPath}`);

  const multiGraph = buildMultiSourceGraph();
  let passes = 0;
  let fails = 0;

  for (let i = 1; i <= N; i++) {
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const { events, close } = collectEvents(orgId, jobId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalState = await multiGraph.invoke({
      orgId,
      jobId,
      userId: DEMO_USER_ID,
      conversationId,
      connectionIds: [connectionIds.mysql, connectionIds.mongodb],
      scope: { orgId },
      rawMessage: "How many employees are there in total, across these sources?",
      standaloneMessage: "How many employees are there in total, across these sources?",
    });
    await close();

    const value = finalState.reduceOutcome?.ok === true ? finalState.reduceOutcome.value : undefined;
    const ok = finalState.reduceOutcome?.ok === true && value === 6;

    const artifact = {
      run: i,
      ok,
      value,
      reductionPlan: finalState.reductionPlan,
      sourceResults: finalState.sourceResults.map((sr) => ({
        connectionId: sr.connectionId,
        ok: sr.ok,
        error: sr.error,
        timedOut: sr.timedOut,
        executedQuery: sr.tabularResult?.meta.executedQuery,
        rowCount: sr.tabularResult?.meta.rowCount,
        truncated: sr.tabularResult?.meta.truncated,
        columns: sr.tabularResult?.columns,
        rows: sr.tabularResult?.rows,
      })),
      reduceOutcome: finalState.reduceOutcome,
      error: finalState.error,
      refusal: finalState.refusal,
      conflictMessage: finalState.conflictMessage,
      citationEvents: events.filter((e) => e.type === "citation"),
    };
    appendFileSync(artifactPath, JSON.stringify(artifact) + "\n");

    if (ok) {
      passes++;
      log(`  [${i}/${N}] PASS  value=${value}`);
    } else {
      fails++;
      log(`  [${i}/${N}] FAIL  value=${value}  reduceOutcome=${JSON.stringify(finalState.reduceOutcome)}`);
      for (const sr of artifact.sourceResults) {
        log(`           source ${sr.connectionId}: rowCount=${sr.rowCount} truncated=${sr.truncated}`);
        log(`             query: ${sr.executedQuery}`);
        log(`             rows: ${JSON.stringify(sr.rows)}`);
      }
    }
  }

  log(`\n=== ${passes}/${N} passed, ${fails}/${N} failed ===`);
  log(`Full artifacts: ${artifactPath}`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
