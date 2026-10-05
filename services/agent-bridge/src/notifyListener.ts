import { Client } from "pg";
import { taskBus } from "./taskBus.js";

/**
 * Bridges Postgres LISTEN/NOTIFY into the in-process taskBus so a held
 * check-in wakes immediately when apps/api publishes or unpublishes a
 * platform setup for that agent (0073_agent_setup_publish.sql's
 * publish_agent_setup/unpublish_agent_setup both
 * `perform pg_notify('agent_setup_published', agent_id::text)`), instead
 * of waiting out the full check-in hold. Not required for correctness —
 * B.4's "nothing is lost while an agent is offline" already holds via the
 * next check-in's own fresh query (see app.ts's check-in handler); this
 * only shortens the wait for an agent that happens to be mid-hold when
 * the publish/unpublish lands.
 *
 * Uses a dedicated Client, never a pool connection — LISTEN is a
 * session-level command, so it needs one connection held open for the
 * process's whole lifetime rather than borrowed-and-returned like every
 * other query in this service.
 */
export async function startAgentSetupNotifyListener(connectionString: string): Promise<Client> {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query("listen agent_setup_published");

  client.on("notification", (msg) => {
    if (msg.channel === "agent_setup_published" && msg.payload) {
      taskBus.wakeAgent(msg.payload);
    }
  });

  // A dropped LISTEN connection only delays wake notifications until the
  // next check-in's own poll — never fatal to the service.
  client.on("error", (err) => {
    console.error("agent_setup_published listener error:", err.message);
  });

  return client;
}
