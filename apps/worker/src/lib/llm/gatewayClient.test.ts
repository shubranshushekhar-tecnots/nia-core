import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Console v2 Slice 2 — proves gatewayClient.ts's recordLlmUsage wiring:
 * one row per complete()/streamComplete() call with correct tokens/
 * feature/scope, a recorder failure never breaks the underlying LLM call,
 * an aborted stream is recorded with usage undefined (usage_known=false
 * per recordLlmUsage's own contract), and each retry attempt (two
 * complete() calls from parseHelpers.completeJson) records its own row.
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

const { complete, streamComplete } = await import("./gatewayClient.js");
const { completeJson } = await import("./parseHelpers.js");

const scope = { ownerId: "owner-1" };
const messages = [{ role: "user" as const, content: "hi" }];

beforeEach(() => {
  createMock.mockReset();
  recordLlmUsageMock.mockReset();
});

describe("complete", () => {
  it("records exactly one ok row with the resolved feature/scope/tokens", async () => {
    createMock.mockResolvedValueOnce({
      choices: [{ message: { content: "hello" } }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    });

    const result = await complete(messages, { node: "test", feature: "chat_build_answer", scope, jobId: "job-1" });

    expect(result).toBe("hello");
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({
      scope,
      runId: "job-1",
      feature: "chat_build_answer",
      status: "ok",
      usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 },
    });
  });

  it("records an error row and still rethrows when the gateway call fails", async () => {
    const boom = new Error("gateway unreachable");
    createMock.mockRejectedValueOnce(boom);

    await expect(complete(messages, { node: "test", feature: "chat_faithfulness", scope })).rejects.toThrow(boom);

    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({ status: "error", feature: "chat_faithfulness" });
    expect((record.errorCode as string)).toContain("gateway unreachable");
  });

  it("a recorder failure never breaks the underlying LLM call", async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }], usage: undefined });
    recordLlmUsageMock.mockRejectedValueOnce(new Error("ledger write failed"));

    await expect(complete(messages, { node: "test", feature: "plan_generation", scope })).resolves.toBe("ok");
  });

  it("each retry attempt from completeJson records its own row", async () => {
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: "not json" } }], usage: undefined });
    createMock.mockResolvedValueOnce({ choices: [{ message: { content: '{"a":1}' } }], usage: undefined });

    const result = await completeJson(messages, { node: "test", feature: "mapping_proposal", scope });

    expect(result).toEqual({ a: 1 });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(2);
  });
});

describe("streamComplete", () => {
  async function* chunks(parts: { delta?: string; usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }[]) {
    for (const part of parts) {
      yield {
        choices: [{ delta: { content: part.delta } }],
        usage: part.usage,
      };
    }
  }

  it("records exactly one ok row with the accumulated usage on a clean stream", async () => {
    createMock.mockResolvedValueOnce(
      chunks([{ delta: "hel" }, { delta: "lo" }, { usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } }]),
    );
    const onToken = vi.fn();

    const result = await streamComplete(messages, onToken, { node: "test", feature: "chat_build_answer", scope, jobId: "job-2" });

    expect(result).toBe("hello");
    expect(onToken).toHaveBeenCalledTimes(2);
    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record).toMatchObject({ status: "ok", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } });
  });

  it("records status=aborted with usage undefined when the stream is cut off, then rethrows", async () => {
    async function* brokenStream() {
      yield { choices: [{ delta: { content: "partial" } }], usage: undefined };
      throw new Error("connection dropped");
    }
    createMock.mockResolvedValueOnce(brokenStream());

    await expect(
      streamComplete(messages, vi.fn(), { node: "test", feature: "chat_build_answer_multi", scope }),
    ).rejects.toThrow("connection dropped");

    expect(recordLlmUsageMock).toHaveBeenCalledTimes(1);
    const record = recordLlmUsageMock.mock.calls[0]![1];
    expect(record.status).toBe("aborted");
    expect(record.usage).toBeUndefined();
    expect((record.errorCode as string)).toContain("connection dropped");
  });

  it("a recorder failure never masks the stream's own thrown error", async () => {
    async function* brokenStream() {
      yield { choices: [{ delta: { content: "partial" } }], usage: undefined };
      throw new Error("connection dropped");
    }
    createMock.mockResolvedValueOnce(brokenStream());
    recordLlmUsageMock.mockRejectedValueOnce(new Error("ledger write failed"));

    await expect(
      streamComplete(messages, vi.fn(), { node: "test", feature: "chat_build_answer_multi", scope }),
    ).rejects.toThrow("connection dropped");
  });
});
