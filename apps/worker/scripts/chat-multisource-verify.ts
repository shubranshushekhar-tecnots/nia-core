/**
 * Task 1 acceptance-bar runner: "15 consecutive passes of the full
 * multi-source suite." Reuses chat-smoke.ts's exact seeding + all 4
 * multi-source assertions (count success, unsupported-operation refusal,
 * partial-failure refusal, genuine cross-source tie/conflict) verbatim,
 * looped N times (default 15) against real infra + real model. Unlike
 * chat-count-diagnose.ts (which isolates just the COUNT case for fast
 * root-cause iteration), this exercises the whole multi-source assertion
 * set every pass, since the prompt fix touched both queryGen.mongo.ts and
 * queryGen.sqlShared.ts (used by every SQL-dialect multi-source query, not
 * just COUNT/SUM) and the max/min + refusal paths must be proven not to
 * have regressed.
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/chat-multisource-verify.ts [N]
 * (N defaults to 15). Exits non-zero if any pass has any assertion failure.
 */
import { randomUUID } from "node:crypto";
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
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
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

  log("=== SEEDING ===");
  const orgId = await getOrgId();
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection(orgId, "mysql"),
    mongodb: await seedConnection(orgId, "mongodb"),
    supabase: await seedConnection(orgId, "supabase"),
  };
  log(`Seeded connections: ${JSON.stringify(connectionIds)}`);

  const multiGraph = buildMultiSourceGraph();

  async function invokeMulti(rawMessage: string, ids: string[]) {
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const { events, close } = collectEvents(orgId, jobId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const finalState = await multiGraph.invoke({
      orgId,
      jobId,
      userId: DEMO_USER_ID,
      conversationId,
      connectionIds: ids,
      scope: { orgId },
      rawMessage,
      standaloneMessage: rawMessage,
    });
    await close();
    return { finalState, events };
  }

  let totalFailures = 0;
  let passRuns = 0;

  for (let i = 1; i <= N; i++) {
    let runFailures = 0;
    const fails: string[] = [];
    function assert(label: string, cond: boolean, detail?: unknown): void {
      if (!cond) {
        runFailures++;
        fails.push(`${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
      }
    }

    // count success
    {
      const { finalState, events } = await invokeMulti(
        "How many employees are there in total, across these sources?",
        [connectionIds.mysql, connectionIds.mongodb],
      );
      assert("count: no pipeline error", !finalState.error, finalState.error);
      assert("count: not refused", !finalState.refusal, finalState.refusal);
      assert("count: not a conflict", !finalState.conflictMessage, finalState.conflictMessage);
      assert(
        "count: reduced to 6",
        finalState.reduceOutcome?.ok === true && finalState.reduceOutcome.value === 6,
        finalState.reduceOutcome,
      );
      assert("count: faithful", finalState.faithful === true, finalState.faithfulnessReason);
      const citationEvents = events.filter((e) => e.type === "citation");
      assert("count: exactly 2 citations", citationEvents.length === 2, citationEvents);
      const doneEvents = events.filter((e) => e.type === "done");
      assert("count: exactly one done event", doneEvents.length === 1, doneEvents);
    }

    // unsupported-operation refusal
    {
      const { finalState, events } = await invokeMulti("List every employee across these sources.", [
        connectionIds.mysql,
        connectionIds.mongodb,
      ]);
      assert("refusal: unsupported-operation", finalState.refusal?.kind === "unsupported-operation", finalState.refusal);
      const citationEvents = events.filter((e) => e.type === "citation");
      assert("refusal: no source dispatched", citationEvents.length === 0, citationEvents);
      const refusedEvents = events.filter((e) => e.type === "refused");
      assert("refusal: exactly one refused event", refusedEvents.length === 1, refusedEvents);
    }

    // partial-failure refusal
    {
      const { finalState, events } = await invokeMulti("How many employees are there in total, across these sources?", [
        connectionIds.mysql,
        "00000000-0000-0000-0000-000000000000",
      ]);
      assert("partial-failure: refused as partial-failure", finalState.refusal?.kind === "partial-failure", finalState.refusal);
      const doneEvents = events.filter((e) => e.type === "done");
      assert("partial-failure: no done event", doneEvents.length === 0, doneEvents);
    }

    // genuine cross-source tie/conflict
    {
      const { finalState, events } = await invokeMulti("Who has the highest salary, across these sources?", [
        connectionIds.mysql,
        connectionIds.mongodb,
        connectionIds.supabase,
      ]);
      assert("conflict: not refused", !finalState.refusal, finalState.refusal);
      assert("conflict: conflictMessage set", typeof finalState.conflictMessage === "string", finalState.conflictMessage);
      assert("conflict: no answer generated", finalState.answer === undefined, finalState.answer);
      const conflictEvents = events.filter((e) => e.type === "conflict");
      assert("conflict: exactly one conflict event", conflictEvents.length === 1, conflictEvents);
      const doneEvents = events.filter((e) => e.type === "done");
      assert("conflict: no done event", doneEvents.length === 0, doneEvents);
      const citationEvents = events.filter((e) => e.type === "citation");
      assert("conflict: no citation event", citationEvents.length === 0, citationEvents);
    }

    if (runFailures === 0) {
      passRuns++;
      log(`  [${i}/${N}] PASS  (all 4 multi-source assertions)`);
    } else {
      totalFailures += runFailures;
      log(`  [${i}/${N}] FAIL  (${runFailures} assertion failure(s))`);
      for (const f of fails) log(`           ${f}`);
    }
  }

  log(`\n=== ${passRuns}/${N} full passes, ${N - passRuns}/${N} runs with failures (${totalFailures} total assertion failures) ===`);
  process.exit(passRuns === N ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
