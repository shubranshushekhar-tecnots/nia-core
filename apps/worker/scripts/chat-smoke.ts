/**
 * Live smoke test for the chat pipeline against real infrastructure AND a
 * real model — NOT mocks. Covers both the single-source graph
 * (apps/worker/src/lib/chat/graph.ts, Phase 2) and the multi-source fan-out
 * graph (apps/worker/src/lib/chat/multiSource/graph.ts, Phase 3).
 * graph.test.ts / multiSource/graph.test.ts already prove each pipeline's
 * structural guarantees (guardrail retry bound, faithfulness retry bound +
 * loud failure, code-level truncation caveat, tie-as-terminal-conflict,
 * refusal kinds) against mocked LLM/connector calls; this script is the
 * actual exit criterion for both phases: ask a real question, get a real
 * model-generated query dispatched against real sandbox databases, and a
 * real model-generated answer (or a real refusal/conflict) — for all three
 * connector kinds individually (Phase 2), and fanned out across them
 * (Phase 3).
 *
 * The Phase 3 section deliberately reuses the SAME seed data as Phase 2
 * rather than adding rows: every sandbox DB seeds the identical 3 employees
 * (Ada Lovelace/Grace Hopper/Alan Turing, salaries 145000/162000/158000 —
 * see docker/dev-{mysql,postgres}-init.sql and dev-mongo-init.js), so
 * "highest salary" across ANY combination of 2+ sources ties for real at
 * Grace Hopper/162000 in every source — that's the genuine-tie/conflict
 * assertion below, and COUNT/SUM are used instead for the unambiguous
 * happy-path assertion (3 rows/465000 per source, doubling cleanly across
 * exactly 2 sources with no tie possible).
 *
 * Run with (from apps/worker/):
 *   npx tsx scripts/chat-smoke.ts
 * (reads apps/worker/.env via dotenv/config, same as env.ts — needs
 * SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/REDIS_URL/NIA_GATEWAY_API_KEY)
 *
 * Prerequisites (not started by this script — same as dispatch-smoke.ts):
 *   - `supabase start`
 *   - `docker compose up -d --build redis dev-mysql dev-mongo dev-postgres
 *     connector-mysql connector-mongodb connector-supabase`
 *   - the three sandbox DBs must have an `employees(name, salary)` seed —
 *     see docker/dev-{mysql,postgres}-init.sql and dev-mongo-init.js. If
 *     those containers were created before this table was added to the
 *     init scripts, seed it by hand once (init scripts only run on first
 *     boot of a fresh volume).
 *
 * Reuses dispatch-smoke.ts's exact seeding conventions (service-role
 * Supabase client, docker-compose service names/internal ports for the
 * connection `config`, since the connector SERVICE containers dial that,
 * not this script). See that file's header comment for the full
 * host-vs-container-network rationale.
 *
 * The chat graph's nodes publish ChatStreamEvents to Redis pub/sub
 * (chat:events:{orgId}:{jobId}, see lib/chat/publish.ts) rather than
 * returning them from invoke() — so this script subscribes to that channel
 * BEFORE invoking the graph, mirroring apps/api/src/routes/chat.ts's real
 * subscriber, to collect the citation/done events alongside the final
 * graph state. jobId here is a synthetic randomUUID() per assertion (this
 * script bypasses the BullMQ queue entirely), not a real BullMQ job id.
 */
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "ioredis";
import type { ChatStreamEvent, ChatStreamEnvelope } from "@nia/schemas";
import { buildChatGraph } from "../src/lib/chat/graph.js";
import { buildMultiSourceGraph } from "../src/lib/chat/multiSource/graph.js";
import { channelFor } from "../src/lib/chat/publish.js";
import { env } from "../src/env.js";
import { runInTrace, flushLangfuse } from "../src/lib/observability/langfuse.js";
import { getSecretStore } from "../src/lib/secretStore.js";
import { dbPool } from "../src/lib/dbPool.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEMO_USER_ID = "00000000-0000-0000-0000-0000000000d1";
// Dialed by the connector SERVICE containers, not this script — see
// dispatch-smoke.ts's header comment for the full rationale.
const SANDBOX = {
  mysql: { host: "dev-mysql", port: 3306, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  mongodb: { host: "dev-mongo", port: 27017, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
  supabase: { host: "dev-postgres", port: 5432, database: "sandbox", user: "nia_ro", password: "nia_ro_pw" },
} as const;

type ConnectorId = keyof typeof SANDBOX;
type Scope = { orgId: string; ownerId?: undefined } | { orgId?: undefined; ownerId: string };

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

async function getOrgId(): Promise<string> {
  const { data, error } = await supabase.from("organizations").select("id").eq("slug", "icecream-co").single();
  if (error || !data) throw new Error(`Could not find seed.sql's demo org: ${error?.message}`);
  return data.id as string;
}

async function seedConnection(scope: Scope, connectorId: ConnectorId): Promise<string> {
  const { host, port, database, user, password } = SANDBOX[connectorId];
  // Same org_id/owner_id xor shape as everywhere else (resolveConnection.ts,
  // connections service, RLS policies) — never both, never neither.
  const scopeCols = scope.orgId !== undefined ? { org_id: scope.orgId, owner_id: null } : { org_id: null, owner_id: scope.ownerId };
  const handleSuffix = scope.orgId !== undefined ? "chat-smoke" : "chat-smoke-personal";

  let installQuery = supabase
    .from("connector_installs")
    .select("id", { count: "exact", head: true })
    .eq("connector_id", connectorId);
  installQuery =
    scope.orgId !== undefined ? installQuery.eq("org_id", scope.orgId) : installQuery.eq("owner_id", scope.ownerId);
  const { count: installCount } = await installQuery;
  if (!installCount) {
    const { error } = await supabase
      .from("connector_installs")
      .insert({ ...scopeCols, connector_id: connectorId, installed_by_user_id: DEMO_USER_ID });
    if (error) throw new Error(`install ${connectorId} failed: ${error.message}`);
  }

  const handle = `@${connectorId}-${handleSuffix}`;
  let existingQuery = supabase.from("connections").select("id").eq("handle", handle);
  existingQuery =
    scope.orgId !== undefined ? existingQuery.eq("org_id", scope.orgId) : existingQuery.eq("owner_id", scope.ownerId);
  const { data: existing } = await existingQuery.maybeSingle();
  if (existing) {
    const { error } = await supabase
      .from("connections")
      .update({ config: { host, port, database } })
      .eq("id", existing.id as string);
    if (error) throw new Error(`connection config update for ${connectorId} failed: ${error.message}`);
    return existing.id as string;
  }

  let vaultRef: string;
  try {
    vaultRef = await getSecretStore(dbPool).put({ user, password }, scope);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`secret write for ${connectorId} failed: ${message}`);
  }

  const { data, error } = await supabase
    .from("connections")
    .insert({
      ...scopeCols,
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

/** Subscribes to the chat pipeline's Redis pub/sub channel and collects every event. */
function collectEvents(scope: Scope, jobId: string): { events: ChatStreamEvent[]; close: () => Promise<void> } {
  const client = new Redis(env.REDIS_URL);
  const channel = channelFor(scope, jobId);
  const events: ChatStreamEvent[] = [];
  client.subscribe(channel);
  client.on("message", (receivedChannel, raw) => {
    if (receivedChannel !== channel) return;
    events.push((JSON.parse(raw) as ChatStreamEnvelope).event);
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
  log("=== SEEDING (not part of the chat pipeline proof below) ===");
  const orgId = await getOrgId();
  const connectionIds: Record<ConnectorId, string> = {
    mysql: await seedConnection({ orgId }, "mysql"),
    mongodb: await seedConnection({ orgId }, "mongodb"),
    supabase: await seedConnection({ orgId }, "supabase"),
  };
  log(`Seeded connections: ${JSON.stringify(connectionIds)}`);

  // Personal (owner_id, org-less) connection — proves the chat pipeline
  // works identically for an individual workspace, not just org scope.
  const personalConnectionId = await seedConnection({ ownerId: DEMO_USER_ID }, "mysql");
  log(`Seeded personal connection: ${personalConnectionId}`);

  log("\n=== ASSERTIONS: real chat graph, real model, real dispatch ===");
  let failures = 0;

  function assert(label: string, cond: boolean, detail?: unknown): void {
    if (cond) {
      log(`  PASS  ${label}`);
    } else {
      failures++;
      log(`  FAIL  ${label} ${detail !== undefined ? JSON.stringify(detail) : ""}`);
    }
  }

  const graph = buildChatGraph();

  for (const connectorId of ["mysql", "mongodb", "supabase"] as const) {
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const { events, close } = collectEvents({ orgId }, jobId);
    // Give the subscription a moment to actually register with Redis
    // before the graph starts publishing — same subscribe-before-enqueue
    // ordering concern as apps/web/src/app/api/chat/route.ts, just with a
    // small explicit wait here since there's no BullMQ enqueue step to
    // naturally sequence after.
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalState = await runInTrace(
      {
        jobId,
        scope: { orgId },
        conversationId,
        mode: "single",
        connectionHandles: [connectionIds[connectorId]],
      },
      () =>
        graph.invoke({
          jobId,
          userId: DEMO_USER_ID,
          conversationId,
          connectionId: connectionIds[connectorId],
          scope: { orgId },
          rawMessage: "Who has the highest salary?",
        }),
    );
    await flushLangfuse();
    await close();

    assert(`${connectorId}: no pipeline error`, !finalState.error, finalState.error);
    assert(
      `${connectorId}: answer names Grace Hopper (highest seeded salary, 162000)`,
      typeof finalState.answer === "string" && /grace hopper/i.test(finalState.answer),
      finalState.answer,
    );
    assert(`${connectorId}: faithful`, finalState.faithful === true, finalState.faithfulnessReason);

    const citationEvents = events.filter((e) => e.type === "citation");
    assert(`${connectorId}: exactly one citation event`, citationEvents.length === 1, citationEvents);
    const citation = citationEvents[0];
    assert(
      `${connectorId}: citation carries the executed query`,
      citation?.type === "citation" && citation.executedQuery !== "",
      citation,
    );

    const doneEvents = events.filter((e) => e.type === "done");
    assert(`${connectorId}: exactly one done event`, doneEvents.length === 1, doneEvents);
    assert(
      `${connectorId}: done event reports faithful:true`,
      doneEvents[0]?.type === "done" && doneEvents[0].faithful === true,
      doneEvents[0],
    );
  }

  // --- personal (owner_id, org-less) workspace: identical single-source
  // happy path, but scoped to an individual instead of an org — proves the
  // chat pipeline (dispatch, publish channel, persistence) works the same
  // for personal-workspace users, not just org members.
  {
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const personalScope = { ownerId: DEMO_USER_ID } as const;
    const { events, close } = collectEvents(personalScope, jobId);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const finalState = await runInTrace(
      {
        jobId,
        scope: personalScope,
        conversationId,
        mode: "single",
        connectionHandles: [personalConnectionId],
      },
      () =>
        graph.invoke({
          jobId,
          userId: DEMO_USER_ID,
          conversationId,
          connectionId: personalConnectionId,
          scope: personalScope,
          rawMessage: "Who has the highest salary?",
        }),
    );
    await flushLangfuse();
    await close();

    assert("personal workspace: no pipeline error", !finalState.error, finalState.error);
    assert(
      "personal workspace: answer names Grace Hopper (highest seeded salary, 162000)",
      typeof finalState.answer === "string" && /grace hopper/i.test(finalState.answer),
      finalState.answer,
    );
    assert("personal workspace: faithful", finalState.faithful === true, finalState.faithfulnessReason);

    const citationEvents = events.filter((e) => e.type === "citation");
    assert("personal workspace: exactly one citation event", citationEvents.length === 1, citationEvents);
    const citation = citationEvents[0];
    assert(
      "personal workspace: citation carries the executed query",
      citation?.type === "citation" && citation.executedQuery !== "",
      citation,
    );

    const doneEvents = events.filter((e) => e.type === "done");
    assert("personal workspace: exactly one done event", doneEvents.length === 1, doneEvents);
    assert(
      "personal workspace: done event reports faithful:true",
      doneEvents[0]?.type === "done" && doneEvents[0].faithful === true,
      doneEvents[0],
    );
  }

  log("\n=== ASSERTIONS: real multi-source graph (Phase 3), real model, real dispatch ===");
  const multiGraph = buildMultiSourceGraph();

  async function invokeMulti(rawMessage: string, connectionIds: string[]) {
    const conversationId = randomUUID();
    const jobId = randomUUID();
    const { events, close } = collectEvents({ orgId }, jobId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const finalState = await runInTrace(
      {
        jobId,
        scope: { orgId },
        conversationId,
        mode: "multi",
        connectionHandles: connectionIds,
      },
      () =>
        multiGraph.invoke({
          jobId,
          userId: DEMO_USER_ID,
          conversationId,
          connectionIds,
          scope: { orgId },
          rawMessage,
          standaloneMessage: rawMessage,
        }),
    );
    await flushLangfuse();
    await close();
    return { finalState, events };
  }

  // --- success: SUM/COUNT across 2 real sources never ties, so this is the
  // clean happy path (max/min on this seed data ties across every source —
  // see the conflict case below, deliberately reusing that same seed data
  // rather than adding new rows just to avoid it).
  {
    const { finalState, events } = await invokeMulti(
      "How many employees are there in total, across these sources?",
      [connectionIds.mysql, connectionIds.mongodb],
    );
    assert("multi-source count: no pipeline error", !finalState.error, finalState.error);
    assert("multi-source count: not refused", !finalState.refusal, finalState.refusal);
    assert("multi-source count: not a conflict", !finalState.conflictMessage, finalState.conflictMessage);
    assert(
      "multi-source count: reduced to 6 (3 employees x 2 sources)",
      finalState.reduceOutcome?.ok === true && finalState.reduceOutcome.value === 6,
      finalState.reduceOutcome,
    );
    assert("multi-source count: faithful", finalState.faithful === true, finalState.faithfulnessReason);

    const citationEvents = events.filter((e) => e.type === "citation");
    assert("multi-source count: exactly 2 citation events (one per source)", citationEvents.length === 2, citationEvents);

    const doneEvents = events.filter((e) => e.type === "done");
    assert("multi-source count: exactly one done event", doneEvents.length === 1, doneEvents);
  }

  // --- unsupported-operation refusal: refused before any source is touched ---
  {
    const { finalState, events } = await invokeMulti("List every employee across these sources.", [
      connectionIds.mysql,
      connectionIds.mongodb,
    ]);
    assert(
      "multi-source refusal: unsupported-operation",
      finalState.refusal?.kind === "unsupported-operation",
      finalState.refusal,
    );
    const citationEvents = events.filter((e) => e.type === "citation");
    assert("multi-source refusal: no source was ever dispatched", citationEvents.length === 0, citationEvents);
    const refusedEvents = events.filter((e) => e.type === "refused");
    assert("multi-source refusal: exactly one refused event", refusedEvents.length === 1, refusedEvents);
  }

  // --- partial-failure refusal: one real source + one nonexistent connectionId ---
  {
    const { finalState, events } = await invokeMulti("How many employees are there in total, across these sources?", [
      connectionIds.mysql,
      "00000000-0000-0000-0000-000000000000",
    ]);
    assert("multi-source partial-failure: refused as partial-failure", finalState.refusal?.kind === "partial-failure", finalState.refusal);
    const doneEvents = events.filter((e) => e.type === "done");
    assert("multi-source partial-failure: no done event", doneEvents.length === 0, doneEvents);
  }

  // --- genuine cross-source tie: this seed data intentionally gives Grace
  // Hopper (162000) as the max in EVERY source, so any max/min question
  // across multiple sources ties for real — terminal `conflict`, no answer.
  {
    const { finalState, events } = await invokeMulti("Who has the highest salary, across these sources?", [
      connectionIds.mysql,
      connectionIds.mongodb,
      connectionIds.supabase,
    ]);
    assert("multi-source conflict: not refused", !finalState.refusal, finalState.refusal);
    assert("multi-source conflict: conflictMessage set", typeof finalState.conflictMessage === "string", finalState.conflictMessage);
    assert("multi-source conflict: no answer generated", finalState.answer === undefined, finalState.answer);
    const conflictEvents = events.filter((e) => e.type === "conflict");
    assert("multi-source conflict: exactly one conflict event", conflictEvents.length === 1, conflictEvents);
    const doneEvents = events.filter((e) => e.type === "done");
    assert("multi-source conflict: no done event (terminal, not folded into an answer)", doneEvents.length === 0, doneEvents);
    const citationEvents = events.filter((e) => e.type === "citation");
    assert("multi-source conflict: no citation event (conflict stops before finalize)", citationEvents.length === 0, citationEvents);
  }

  log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILURE(S)`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
