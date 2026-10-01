import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Console v2 Slice 3 mandatory test: "a Copilot turn writes a row" —
 * completeWithTools records exactly one llm_usage row per call, feature
 * "copilot_agent", with the caller's scope + userId, and a recorder failure
 * never breaks the underlying LLM response.
 */
const createMock = vi.fn();
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (...args: unknown[]) => createMock(...args) } };
  },
}));

const recordLlmUsageMock = vi.fn(async (_pool: unknown, _record: Record<string, unknown>) => {});
vi.mock("@nia/db", () => ({
  recordLlmUsage: (pool: unknown, record: Record<string, unknown>) => recordLlmUsageMock(pool, record),
  createDbPool: () => ({}),
}));

const { completeWithTools } = await import("./gatewayClient.js");

const context = { scope: { ownerId: "owner-1" }, userId: "user-1" };
const messages = [{ role: "user" as const, content: "hi" }];

beforeEach(() => {
  createMock.mockReset();
  recordLlmUsageMock.mockReset();
});

describe("completeWithTools", () => {
  it("records exactly one ok row with feature copilot_agent, the caller's scope/userId, and tokens", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "hello", tool_calls: [] } }],
      usage: { prompt_tokens: 11, completion_tokens: 13, total_tokens: 24 },
    });

    const result = await completeWithTools(messages, [], context);

    expect(result).toEqual({ content: "hello", toolCalls: [] });
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({
      scope: context.scope,
      userId: context.userId,
      feature: "copilot_agent",
      status: "ok",
      usage: { inputTokens: 11, outputTokens: 13, totalTokens: 24 },
    });
  });

  it("records usage from a tool-calling turn too (not just plain-text replies)", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "x", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    });

    const result = await completeWithTools(messages, [{ type: "function", function: { name: "x", parameters: {} } }], context);

    expect(result.toolCalls).toHaveLength(1);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({ feature: "copilot_agent", status: "ok", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } });
  });

  it("records an error row and still rethrows when the gateway call fails", async () => {
    const boom = new Error("gateway unreachable");
    createMock.mockRejectedValueOnce(boom);

    await expect(completeWithTools(messages, [], context)).rejects.toThrow(boom);

    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({ feature: "copilot_agent", status: "error" });
    expect((record.errorCode as string)).toContain("gateway unreachable");
  });

  it("a recorder failure never masks a successful LLM response's own call-site propagation", async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: "ok", tool_calls: [] } }], usage: undefined });
    recordLlmUsageMock.mockRejectedValueOnce(new Error("ledger write failed"));

    await expect(completeWithTools(messages, [], context)).rejects.toThrow("ledger write failed");
  });
});
