import type { QueryPayload } from "@nia/schemas";
import { describe, expect, it } from "vitest";
import { validateMongoPipeline } from "./mongodb.js";

const scope = { connectionId: "conn_1" };

describe("validateMongoPipeline", () => {
  it("allows a simple match/project/sort pipeline and injects a $limit", () => {
    const result = validateMongoPipeline(
      {
        kind: "mongo",
        collection: "orders",
        pipeline: [{ $match: { status: "open" } }, { $sort: { createdAt: -1 } }],
      },
      scope,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.sanitizedQuery.kind === "mongo") {
      expect(result.sanitizedQuery.pipeline.at(-1)).toEqual({ $limit: 1000 });
    }
  });

  it("caps an oversized $limit", () => {
    const result = validateMongoPipeline(
      { kind: "mongo", collection: "orders", pipeline: [{ $limit: 999999 }] },
      scope,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.sanitizedQuery.kind === "mongo") {
      expect(result.sanitizedQuery.pipeline[0]).toEqual({ $limit: 1000 });
    }
  });

  it("rejects forbidden stages: $out, $merge", () => {
    expect(
      validateMongoPipeline(
        { kind: "mongo", collection: "orders", pipeline: [{ $out: "copy" }] },
        scope,
      ).ok,
    ).toBe(false);
    expect(
      validateMongoPipeline(
        { kind: "mongo", collection: "orders", pipeline: [{ $merge: { into: "copy" } }] },
        scope,
      ).ok,
    ).toBe(false);
  });

  it("rejects forbidden operators nested inside $match/$project expressions", () => {
    const result = validateMongoPipeline(
      {
        kind: "mongo",
        collection: "orders",
        pipeline: [{ $match: { $expr: { $function: { body: "function() {}" } } } }],
      },
      scope,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects $where", () => {
    const result = validateMongoPipeline(
      { kind: "mongo", collection: "orders", pipeline: [{ $match: { $where: "this.x == 1" } }] },
      scope,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects collections outside the connection scope", () => {
    const result = validateMongoPipeline(
      { kind: "mongo", collection: "secrets", pipeline: [{ $match: {} }] },
      { connectionId: "c1", allowedTargets: ["orders"] },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects $lookup targeting an out-of-scope collection", () => {
    const result = validateMongoPipeline(
      {
        kind: "mongo",
        collection: "orders",
        pipeline: [{ $lookup: { from: "secrets", localField: "id", foreignField: "orderId", as: "s" } }],
      },
      { connectionId: "c1", allowedTargets: ["orders"] },
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a stage object with more than one operator key", () => {
    const result = validateMongoPipeline(
      {
        kind: "mongo",
        collection: "orders",
        pipeline: [{ $match: {}, $sort: {} }],
      },
      scope,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a query payload with a different kind", () => {
    const result = validateMongoPipeline(
      { kind: "sql", sql: "SELECT 1", params: [] },
      scope,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed pipeline shape even when kind claims mongo", () => {
    const result = validateMongoPipeline(
      { kind: "mongo", collection: "orders", pipeline: ["not-an-object"] } as unknown as QueryPayload,
      scope,
    );
    expect(result.ok).toBe(false);
  });
});
