import { describe, expect, it } from "vitest";
import { NdjsonWriter } from "../ndjsonWriter.js";
import { consumePlanometryStream, StreamProtocolError } from "./planometryClient.js";

/** Wraps a fixed array of pre-split chunks as an AsyncIterable, tracking whether the consumer ever called `.return()` on it (i.e. disconnected before exhausting the source). */
function chunksOf(parts: string[]): { source: AsyncIterable<string>; returned: { called: boolean } } {
  const returned = { called: false };
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < parts.length) return { value: parts[i++]!, done: false as const };
          return { value: undefined, done: true as const };
        },
        async return(value?: unknown) {
          returned.called = true;
          return { value, done: true as const };
        },
      };
    },
  };
  return { source, returned };
}

/** Re-chunks a full NDJSON string into irregular pieces that don't align with line boundaries, to prove the client buffers correctly regardless of transport framing. */
function chopIrregularly(full: string, sizes: number[]): string[] {
  const parts: string[] = [];
  let i = 0;
  for (const size of sizes) {
    parts.push(full.slice(i, i + size));
    i += size;
  }
  if (i < full.length) parts.push(full.slice(i));
  return parts;
}

function produce(write: (chunk: string) => void, rows: number[][]): void {
  const w = new NdjsonWriter(write);
  w.writeColumns([{ name: "id", type: "number" }]);
  for (const row of rows) w.writeRow(row);
  w.writeEnd();
}

describe("consumePlanometryStream", () => {
  it("round-trips columns, rows, and the trailer count through an NdjsonWriter producer, even when transport chunking splits lines arbitrarily", async () => {
    let full = "";
    produce((c) => {
      full += c;
    }, [[1], [2], [3]]);

    const { source } = chunksOf(chopIrregularly(full, [1, 7, 3, 50]));
    const result = await consumePlanometryStream(source);

    expect(result.columns).toEqual([{ name: "id", type: "number" }]);
    expect(result.rows).toEqual([[1], [2], [3]]);
    expect(result.trailerRowCount).toBe(3);
    expect(result.error).toBeNull();
    expect(result.disconnected).toBe(false);
  });

  it("counts blank keep-alive lines without treating them as rows", async () => {
    let full = "";
    const w = new NdjsonWriter((c) => {
      full += c;
    });
    w.writeColumns([{ name: "id", type: "number" }]);
    w.writeRow([1]);
    full += "\n"; // a keep-alive line, as emitted by startKeepAlive()
    w.writeRow([2]);
    w.writeEnd();

    const { source } = chunksOf([full]);
    const result = await consumePlanometryStream(source);

    expect(result.keepAlives).toBe(1);
    expect(result.rows).toEqual([[1], [2]]);
    expect(result.trailerRowCount).toBe(2);
  });

  it("surfaces a failure line as `error` with no trailer, rather than throwing", async () => {
    let full = "";
    const w = new NdjsonWriter((c) => {
      full += c;
    });
    w.writeColumns([{ name: "id", type: "number" }]);
    w.writeRow([1]);
    w.writeError("connection lost");

    const { source } = chunksOf([full]);
    const result = await consumePlanometryStream(source);

    expect(result.error).toBe("connection lost");
    expect(result.trailerRowCount).toBeNull();
    expect(result.rows).toEqual([[1]]);
  });

  it("rejects a stream that doesn't open with the columns header", async () => {
    const { source } = chunksOf(["[1]\n"]);
    await expect(consumePlanometryStream(source)).rejects.toThrow(StreamProtocolError);
  });

  it("rejects a trailer whose row count disagrees with what was actually received", async () => {
    const lines = [JSON.stringify({ columns: [{ name: "id", type: "number" }] }), JSON.stringify([1]), JSON.stringify({ end: true, rows: 5 })].join("\n") + "\n";
    const { source } = chunksOf([lines]);
    await expect(consumePlanometryStream(source)).rejects.toThrow(/claims 5 row\(s\) but only 1/);
  });

  it("rejects a stream that ends without a trailer or an error line", async () => {
    const lines = [JSON.stringify({ columns: [{ name: "id", type: "number" }] }), JSON.stringify([1])].join("\n") + "\n";
    const { source } = chunksOf([lines]);
    await expect(consumePlanometryStream(source)).rejects.toThrow(/ended without a trailer/);
  });

  it("disconnects after N rows without waiting for the trailer, and tears down the underlying source", async () => {
    let full = "";
    produce((c) => {
      full += c;
    }, [[1], [2], [3], [4], [5]]);

    const { source, returned } = chunksOf([full]);
    const result = await consumePlanometryStream(source, { disconnectAfterRows: 2 });

    expect(result.rows).toEqual([[1], [2]]);
    expect(result.disconnected).toBe(true);
    expect(result.trailerRowCount).toBeNull();
    expect(returned.called).toBe(true);
  });
});
