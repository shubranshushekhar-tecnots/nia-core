import { describe, expect, it, vi, beforeEach } from "vitest";

const completeMock = vi.fn();
vi.mock("./gatewayClient.js", () => ({
  complete: (...args: unknown[]) => completeMock(...args),
}));

const { extractJson, completeJson, JsonExtractionError, stripFences } = await import("./parseHelpers.js");

describe("stripFences", () => {
  it("strips a ```json fenced block", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("passes unfenced text through unchanged (trimmed)", () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}');
  });
});

describe("extractJson", () => {
  const ctx = { node: "test-node" };

  it("parses plain JSON directly", () => {
    expect(extractJson('{"a":1}', ctx)).toEqual({ a: 1 });
  });

  it("parses fenced JSON", () => {
    expect(extractJson('```json\n{"a":1}\n```', ctx)).toEqual({ a: 1 });
  });

  it("salvages JSON preceded by prose", () => {
    const raw = 'Let me reconsider the aggregation pipeline for a moment.\n\n{"collection":"employees","pipeline":[{"$match":{}}]}';
    expect(extractJson(raw, ctx)).toEqual({ collection: "employees", pipeline: [{ $match: {} }] });
  });

  it("salvages JSON followed by prose", () => {
    const raw = '{"sql":"SELECT 1"} \n\nHope that helps! Let me know if you need anything else.';
    expect(extractJson(raw, ctx)).toEqual({ sql: "SELECT 1" });
  });

  it("salvages JSON surrounded by prose on both sides", () => {
    const raw = 'Sure thing — here is the query:\n{"sql":"SELECT 1"}\nLet me know if that works.';
    expect(extractJson(raw, ctx)).toEqual({ sql: "SELECT 1" });
  });

  it("handles braces inside string values without breaking depth tracking", () => {
    const raw = '{"sql":"SELECT * FROM t WHERE json_col = \'{\\"nested\\":true}\'"}';
    expect(extractJson(raw, ctx)).toEqual({ sql: 'SELECT * FROM t WHERE json_col = \'{"nested":true}\'' });
  });

  it("logs a structured console.warn when it had to salvage", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    extractJson('prose before {"a":1}', ctx);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warnSpy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({ event: "llm_json_salvage", node: "test-node" });
    expect(typeof logged.model).toBe("string");
    warnSpy.mockRestore();
  });

  it("does NOT log when JSON parses cleanly on the first try (no salvage needed)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    extractJson('{"a":1}', ctx);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("throws JsonExtractionError on truncated JSON", () => {
    expect(() => extractJson('{"a": "bar", "baz":', ctx)).toThrow(JsonExtractionError);
  });

  it("throws JsonExtractionError when there is no JSON at all", () => {
    expect(() => extractJson("I cannot help with that request.", ctx)).toThrow(JsonExtractionError);
  });
});

describe("completeJson", () => {
  const ctx = { node: "test-node" };
  const messages = [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "usr" }];

  beforeEach(() => {
    completeMock.mockReset();
  });

  it("returns the parsed result on a clean first attempt, without retrying", async () => {
    completeMock.mockResolvedValueOnce('{"a":1}');
    const result = await completeJson(messages, ctx);
    expect(result).toEqual({ a: 1 });
    expect(completeMock).toHaveBeenCalledTimes(1);
  });

  it("retries once with a JSON-only addendum when the first attempt is unparseable, and succeeds", async () => {
    completeMock.mockResolvedValueOnce("I cannot produce that.");
    completeMock.mockResolvedValueOnce('{"a":1}');

    const result = await completeJson(messages, ctx);

    expect(result).toEqual({ a: 1 });
    expect(completeMock).toHaveBeenCalledTimes(2);
    const retryMessages = completeMock.mock.calls[1]![0] as { role: string; content: string }[];
    expect(retryMessages).toHaveLength(messages.length + 1);
    expect(retryMessages[retryMessages.length - 1]).toMatchObject({ role: "system", content: expect.stringContaining("ONLY the JSON") });
  });

  it("propagates JsonExtractionError if the retry also fails", async () => {
    completeMock.mockResolvedValueOnce("nope.");
    completeMock.mockResolvedValueOnce("still nope.");

    await expect(completeJson(messages, ctx)).rejects.toThrow(JsonExtractionError);
    expect(completeMock).toHaveBeenCalledTimes(2);
  });
});
