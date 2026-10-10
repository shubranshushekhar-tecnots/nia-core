import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { RequestBuilderError, buildRequestParts, type RequestPart } from "./requestBuilder.js";

function row(id: number): Record<string, unknown> {
  return { Id: id };
}

function* rows(count: number): Generator<Record<string, unknown>> {
  for (let i = 0; i < count; i++) yield row(i);
}

async function collect(gen: AsyncGenerator<RequestPart>): Promise<RequestPart[]> {
  const parts: RequestPart[] = [];
  for await (const part of gen) parts.push(part);
  return parts;
}

function gunzipJson(body: Buffer): unknown {
  return JSON.parse(zlib.gunzipSync(body).toString("utf8"));
}

describe("buildRequestParts: row limit", () => {
  it(
    "120,001 rows at limit 50,000 give parts of 50,000, 50,000 and 20,001, only the third marked last",
    async () => {
      const parts = await collect(buildRequestParts({ mode: "upsert", rows: rows(120_001), schemaRowLimit: 50_000 }));
      expect(parts.map((p) => p.rowCount)).toEqual([50_000, 50_000, 20_001]);
      expect(parts.map((p) => p.last)).toEqual([false, false, true]);
    },
    // Gzip + chunking 120k rows is genuinely slow under load; the vitest
    // default 5000ms timeout has been observed to flake on this machine
    // even in isolation. Raised, not the logic.
    30_000,
  );

  it("exactly the row limit gives one part marked last", async () => {
    const parts = await collect(buildRequestParts({ mode: "upsert", rows: rows(50_000), schemaRowLimit: 50_000 }));
    expect(parts).toHaveLength(1);
    expect(parts[0].rowCount).toBe(50_000);
    expect(parts[0].last).toBe(true);
  });

  it("zero rows gives one empty part marked last", async () => {
    const parts = await collect(buildRequestParts({ mode: "upsert", rows: rows(0), schemaRowLimit: 50_000 }));
    expect(parts).toHaveLength(1);
    expect(parts[0].rowCount).toBe(0);
    expect(parts[0].last).toBe(true);
    const body = gunzipJson(parts[0].body) as { rows: unknown[] };
    expect(body.rows).toEqual([]);
  });

  it("a /schema limit of 80,000 is capped at the hard 50,000 limit", async () => {
    const parts = await collect(buildRequestParts({ mode: "upsert", rows: rows(50_001), schemaRowLimit: 80_000 }));
    expect(parts.map((p) => p.rowCount)).toEqual([50_000, 1]);
  });
});

describe("buildRequestParts: byte limit", () => {
  it("a small byte limit closes a part early, under the row cap", async () => {
    // Each row's JSON is `{"Id":N}` (8-9 bytes) plus a separator — a 50-byte limit admits a
    // handful of rows per part, well under the default row cap.
    const parts = await collect(buildRequestParts({ mode: "upsert", rows: rows(10), schemaRowLimit: 50_000, byteLimit: 50 }));
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.uncompressedBytes).toBeLessThanOrEqual(200); // header + rows well within slack
    }
    const totalRows = parts.reduce((sum, p) => sum + p.rowCount, 0);
    expect(totalRows).toBe(10);
    expect(parts[parts.length - 1].last).toBe(true);
  });

  it("multi-byte text is counted in UTF-8 bytes, not string length", async () => {
    const wideRow = { Name: "\u6771\u4eac\u6771\u4eac\u6771\u4eac\u6771\u4eac" }; // 8 CJK chars, 3 bytes each in UTF-8
    const json = JSON.stringify(wideRow);
    const byteLength = Buffer.byteLength(json, "utf8");
    expect(byteLength).toBeGreaterThan(json.length); // sanity: UTF-8 bytes exceed JS string length here

    // A byte limit sized for exactly one row (plus header slack) must still admit it, proving
    // the limit is measured in bytes rather than code units.
    const parts = await collect(
      buildRequestParts({ mode: "upsert", rows: [wideRow], schemaRowLimit: 50_000, byteLimit: byteLength + 100 }),
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].rowCount).toBe(1);
  });

  it("a single row larger than the byte limit errors with its index and no contents", async () => {
    const bigRow = { Blob: "x".repeat(1000) };
    const gen = buildRequestParts({ mode: "upsert", rows: [row(0), bigRow], schemaRowLimit: 50_000, byteLimit: 100 });
    await expect(collect(gen)).rejects.toThrow(RequestBuilderError);
    try {
      await collect(buildRequestParts({ mode: "upsert", rows: [row(0), bigRow], schemaRowLimit: 50_000, byteLimit: 100 }));
    } catch (err) {
      expect(err).toBeInstanceOf(RequestBuilderError);
      expect((err as Error).message).toContain("index 1");
      expect((err as Error).message).not.toContain("x".repeat(1000));
    }
  });
});

describe("buildRequestParts: body shape", () => {
  it("each part gunzips to JSON equal to the expected body", async () => {
    const parts = await collect(
      buildRequestParts({ mode: "replace", rows: rows(2), schemaRowLimit: 50_000, loadId: "load-1", totalRows: 2 }),
    );
    expect(parts).toHaveLength(1);
    const body = gunzipJson(parts[0].body);
    expect(body).toEqual({
      mode: "replace",
      loadId: "load-1",
      last: true,
      totalRows: 2,
      rows: [{ Id: 0 }, { Id: 1 }],
    });
  });

  it("omits totalRows on a part not marked last", async () => {
    const parts = await collect(
      buildRequestParts({ mode: "replace", rows: rows(3), schemaRowLimit: 2, loadId: "load-1", totalRows: 3 }),
    );
    expect(parts).toHaveLength(2);
    const firstBody = gunzipJson(parts[0].body) as Record<string, unknown>;
    expect(firstBody.last).toBe(false);
    expect("totalRows" in firstBody).toBe(false);
    const secondBody = gunzipJson(parts[1].body) as Record<string, unknown>;
    expect(secondBody.last).toBe(true);
    expect(secondBody.totalRows).toBe(3);
  });

  it("rows and deleted together respect the row limit", async () => {
    const parts = await collect(
      buildRequestParts({ mode: "realtime", rows: rows(3), deleted: rows(2), schemaRowLimit: 4 }),
    );
    const totalCounted = parts.reduce((sum, p) => sum + p.rowCount, 0);
    expect(totalCounted).toBe(5);
    expect(parts.every((p) => p.rowCount <= 4)).toBe(true);

    const allRows: unknown[] = [];
    const allDeleted: unknown[] = [];
    for (const part of parts) {
      const body = gunzipJson(part.body) as { rows: unknown[]; deleted: unknown[] };
      allRows.push(...body.rows);
      allDeleted.push(...body.deleted);
    }
    expect(allRows).toEqual([row(0), row(1), row(2)]);
    expect(allDeleted).toEqual([row(0), row(1)]);
  });
});
