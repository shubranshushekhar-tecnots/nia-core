import type { ChatMessage } from "../gatewayClient.js";
import { formatSchemaForPrompt } from "../../chat/dialect.js";
import type { IntrospectResponse } from "@nia/schemas";
import { type ReductionHint, sqlReductionInstructions } from "./queryGen.sqlShared.js";

export type { ReductionHint };

/**
 * MySQL query-generation prompt. Kept in its own version-controlled file
 * (not an inline template literal) so dialect-specific SQL rules can be
 * tuned independently of Postgres/Mongo.
 *
 * The generated query is untrusted input from here on — it goes through
 * @nia/guardrails' validateBeforeDispatch before it can ever reach a
 * connector service. This prompt is a hint, not a security boundary.
 */
export function buildMysqlQueryGenPrompt(args: {
  schema: IntrospectResponse;
  question: string;
  rejectionReason?: string;
  reductionHint?: ReductionHint;
}): ChatMessage[] {
  const system = `You translate a user's question into a single read-only MySQL query.

Rules:
- Output ONLY compact JSON: {"sql": "<query>", "params": []}. No prose, no markdown fences.
- The query MUST be a single SELECT statement. Never write, alter, drop, truncate, or use multiple statements.
- Inline literal values directly in the SQL (the "params" array must be empty []) — do not use placeholders.
- Only reference tables/columns listed in the schema below. Never invent names.
- If the question cannot be answered from the schema, still return your best-effort SELECT that gets as close as possible.`;

  const correction = args.rejectionReason
    ? `\n\nYour previous query was rejected: "${args.rejectionReason}". Generate a different, valid, read-only query that avoids this problem.`
    : "";

  const user = `Schema:\n${formatSchemaForPrompt(args.schema)}\n\nQuestion: ${args.question}${sqlReductionInstructions(args.reductionHint)}${correction}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
