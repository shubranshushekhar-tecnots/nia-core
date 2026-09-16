import type { ChatMessage } from "../gatewayClient.js";
import type { TabularResult } from "@nia/schemas";

const MAX_PREVIEW_ROWS = 200;

function formatRows(result: TabularResult): string {
  const header = result.columns.map((c) => c.name).join(" | ");
  const rows = result.rows
    .slice(0, MAX_PREVIEW_ROWS)
    .map((r) => r.map((v) => JSON.stringify(v)).join(" | "))
    .join("\n");
  return `${header}\n${rows}`;
}

/**
 * Answer-generation prompt. Grounds the model strictly in the executed
 * query's result set — it must never introduce facts not present in the
 * rows. The truncation caveat is ALSO injected here as an explicit
 * instruction (belt), but the structural guarantee is the caveat the
 * buildAnswer node prepends in code regardless of what the model writes
 * (braces) — see chat/nodes/buildAnswer.ts.
 */
export function buildAnswerGenPrompt(args: {
  question: string;
  result: TabularResult;
  rejectionReason?: string;
  previousAnswer?: string;
}): ChatMessage[] {
  const truncationNote = args.result.meta.truncated
    ? `\n\nIMPORTANT: These results were truncated to ${args.result.rows.length} row(s) — they are NOT the complete result set. Do not state or imply any total, count, max, min, sum, or average over "all" rows; explicitly note the answer is based on a partial sample.`
    : "";

  const correction = args.rejectionReason
    ? `\n\nYour previous answer was flagged as not fully supported by the data: "${args.rejectionReason}". Revise the answer so every claim is directly supported by the rows below.${
        args.previousAnswer ? ` Previous answer: "${args.previousAnswer}"` : ""
      }`
    : "";

  const system = `You answer the user's question using ONLY the query result rows provided. Every claim must be directly supported by the data. Do not fabricate or infer beyond what the rows show. Be concise.`;

  const user = `Question: ${args.question}\n\nResult rows:\n${formatRows(args.result)}${truncationNote}${correction}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}
