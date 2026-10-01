import { describe, expect, it, vi } from "vitest";
import { NdjsonWriter } from "./ndjsonWriter.js";

function collector() {
  const chunks: string[] = [];
  return { chunks, write: (c: string) => chunks.push(c) };
}

describe("NdjsonWriter", () => {
  it("writes the columns line first, then one array per row, then the trailer", () => {
    const { chunks, write } = collector();
    const w = new NdjsonWriter(write);
    w.writeColumns([{ name: "id", type: "number" }]);
    w.writeRow([1]);
    w.writeRow([2]);
    w.writeEnd();
    expect(JSON.parse(chunks[0]!)).toEqual({ columns: [{ name: "id", type: "number" }] });
    expect(JSON.parse(chunks[1]!)).toEqual([1]);
    expect(JSON.parse(chunks[2]!)).toEqual([2]);
    expect(JSON.parse(chunks[3]!)).toEqual({ end: true, rows: 2 });
  });

  it("writes an error line with no trailer on failure", () => {
    const { chunks, write } = collector();
    const w = new NdjsonWriter(write);
    w.writeColumns([{ name: "id", type: "number" }]);
    w.writeRow([1]);
    w.writeError("connection lost");
    expect(JSON.parse(chunks.at(-1)!)).toEqual({ error: "connection lost" });
    expect(chunks.some((c) => c.includes('"end"'))).toBe(false);
  });

  it("rejects further writes after close", () => {
    const { write } = collector();
    const w = new NdjsonWriter(write);
    w.writeEnd();
    expect(() => w.writeRow([1])).toThrow();
  });

  it("emits a blank keep-alive line only once >=interval has elapsed since the last line", () => {
    vi.useFakeTimers();
    const { chunks, write } = collector();
    const w = new NdjsonWriter(write, 30_000);
    w.writeColumns([{ name: "id", type: "number" }]);
    w.startKeepAlive(1_000);

    vi.advanceTimersByTime(29_000);
    expect(chunks.filter((c) => c === "\n")).toHaveLength(0);

    vi.advanceTimersByTime(2_000); // crosses 30s since last activity
    expect(chunks.filter((c) => c === "\n")).toHaveLength(1);

    w.writeRow([1]); // resets activity
    vi.advanceTimersByTime(29_000);
    expect(chunks.filter((c) => c === "\n")).toHaveLength(1);

    w.writeEnd();
    vi.useRealTimers();
  });
});
