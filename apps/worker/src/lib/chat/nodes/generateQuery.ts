import type { QueryPayload } from "@nia/schemas";
import { dialectForConnector } from "../dialect.js";
import { completeJson, JsonExtractionError } from "../../llm/parseHelpers.js";
import { buildMysqlQueryGenPrompt } from "../../llm/prompts/queryGen.mysql.js";
import { buildPostgresQueryGenPrompt } from "../../llm/prompts/queryGen.postgres.js";
import { buildMongoQueryGenPrompt } from "../../llm/prompts/queryGen.mongo.js";
import { publishChatEvent } from "../publish.js";
import type { GenerateQueryState } from "./shared.js";

/** Widened to GenerateQueryState (see shared.ts) so this same function is reused unchanged by the multi-source per-source subgraph. */
export async function generateQueryNode(state: GenerateQueryState): Promise<Partial<GenerateQueryState>> {
  await publishChatEvent(state.scope, state.jobId, { type: "status", stage: "generating_query" });
  const connection = state.connection!;
  const schema = state.schema!;
  const dialect = dialectForConnector(connection.connectorId);

  // Only set in the multi-source pipeline. Tie-handling decision (Phase 3):
  // for max/min, the per-source query must return ALL rows tying for the
  // extreme value rather than silently breaking ties with LIMIT 1 — see
  // each dialect prompt's reductionHint instructions.
  const reductionHint = state.reductionPlan?.supported
    ? { operation: state.reductionPlan.operation, targetField: state.reductionPlan.targetField }
    : undefined;

  const promptArgs = {
    schema,
    question: state.standaloneMessage,
    rejectionReason: state.guardrailRejectionReason,
    reductionHint,
  };
  const messages =
    dialect === "mysql"
      ? buildMysqlQueryGenPrompt(promptArgs)
      : dialect === "postgres"
        ? buildPostgresQueryGenPrompt(promptArgs)
        : buildMongoQueryGenPrompt(promptArgs);

  let parsed: unknown;
  try {
    // Deliberately NOT on QUERYGEN_MODEL: every fast flash tier tested
    // (gemini-2.5-flash, gemini-3.5-flash) failed Fix 1's quality gate or
    // speed goal on this gateway account — see PHASE4_EXIT.md §4 Fix 1.
    // Stays on the default model, same as planReduction.ts.
    parsed = await completeJson(messages, { node: "generateQuery" });
  } catch (err) {
    if (!(err instanceof JsonExtractionError)) throw err;
    return { error: `Query generation returned unparseable JSON: ${err.message}` };
  }

  const queryPayload: QueryPayload =
    dialect === "mongo"
      ? { kind: "mongo", collection: (parsed as { collection: string }).collection, pipeline: (parsed as { pipeline: unknown[] }).pipeline as never }
      : { kind: "sql", sql: (parsed as { sql: string }).sql, params: [] };

  // Clear the rejection reason once it's been fed into this attempt — the
  // next guardrail rejection (if any) will set a fresh one.
  return { queryPayload, guardrailRejectionReason: undefined };
}
