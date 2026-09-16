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
 * Faithfulness-check prompt — grades whether an answer is fully supported
 * by the query result rows it was generated from. Deliberately terse
 * output format so the node can parse it reliably without another
 * round-trip.
 */
export function buildFaithfulnessPrompt(args: {
  question: string;
  answer: string;
  result: TabularResult;
}): ChatMessage[] {
  const system = `You grade whether an answer is fully and only supported by the given data rows. Respond with EXACTLY one line:
"OK" if every claim in the answer is directly supported by the rows.
"CONFLICT: <short reason>" if the answer states, implies, or fabricates anything not directly supported by the rows.`;

  const user = `Question: ${args.question}\n\nData rows:\n${formatRows(args.result)}\n\nAnswer to grade: ${args.answer}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function parseFaithfulnessVerdict(raw: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = raw.trim();
  if (/^OK\b/i.test(trimmed)) return { ok: true };
  const match = /^CONFLICT:\s*(.+)$/is.exec(trimmed);
  if (match) return { ok: false, reason: match[1]!.trim() };
  // Unparseable verdict — treat as a conflict rather than silently trusting it.
  return { ok: false, reason: `Unparseable faithfulness verdict: "${trimmed}"` };
}

interface FaithfulnessResultState {
  faithful: boolean;
  faithfulnessReason: string | undefined;
  faithfulnessOutcome: "ok" | "conflict-retry" | "conflict-final";
  answerGenAttempts?: number;
}

/**
 * Shared single-retry-then-ship policy: both faithfulness.ts's node
 * (single-source) and faithfulnessMulti.ts's node (multi-source) grade
 * against different inputs but apply this exact same decision — retry once
 * (bumping answerGenAttempts), then ship the still-flagged answer rather
 * than loop forever (failing loudly beats failing quietly).
 */
export function applyFaithfulnessVerdict(
  verdict: ReturnType<typeof parseFaithfulnessVerdict>,
  answerGenAttempts: number,
): FaithfulnessResultState {
  if (verdict.ok) {
    return { faithful: true, faithfulnessReason: undefined, faithfulnessOutcome: "ok" };
  }
  if (answerGenAttempts >= 1) {
    return { faithful: false, faithfulnessReason: verdict.reason, faithfulnessOutcome: "conflict-final" };
  }
  return {
    faithful: false,
    faithfulnessReason: verdict.reason,
    faithfulnessOutcome: "conflict-retry",
    answerGenAttempts: answerGenAttempts + 1,
  };
}
