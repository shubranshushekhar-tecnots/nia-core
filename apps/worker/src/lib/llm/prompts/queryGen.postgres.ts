import type { ChatMessage } from "../gatewayClient.js";
import { formatSchemaForPrompt } from "../../chat/dialect.js";
import type { IntrospectResponse } from "@nia/schemas";
import { type ReductionHint, sqlReductionInstructions } from "./queryGen.sqlShared.js";

/** Postgres (Supabase connector) query-generation prompt — see queryGen.mysql.ts's header comment. */
export function buildPostgresQueryGenPrompt(args: {
  schema: IntrospectResponse;
  question: string;
  rejectionReason?: string;
  reductionHint?: ReductionHint;
}): ChatMessage[] {
  const system = `You translate a user's question into a single read-only PostgreSQL query.

Rules:
- Output ONLY compact JSON: {"sql": "<query>", "params": []}. No prose, no markdown fences.
- The query MUST be a single SELECT statement. Never write, alter, drop, truncate, or use multiple statements.
- Inline literal values directly in the SQL (the "params" array must be empty []) — do not use placeholders.
- Use double-quoted identifiers only if the schema requires it; otherwise use plain lowercase identifiers.
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
