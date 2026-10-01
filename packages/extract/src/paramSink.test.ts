import { describe, expect, it } from "vitest";
import { createParamSink, resolveParamSink } from "./paramSink.js";

describe("paramSink", () => {
  it("resolves tokens in physical text order, independent of push call order", () => {
    const sink = createParamSink();
    const whereToken = sink.push("where-value");
    const selectToken = sink.push("select-value");
    // physical order is select-first even though it was pushed second
    const physicalSql = `SELECT ${selectToken} FROM t WHERE y = ${whereToken}`;
    const { sql: resolved, params } = resolveParamSink(sink, physicalSql, (i) => `@p${i}`);
    expect(resolved).toBe("SELECT @p1 FROM t WHERE y = @p2");
    expect(params).toEqual(["select-value", "where-value"]);
  });

  it("throws on a duplicate token appearing twice in text", () => {
    const sink = createParamSink();
    const token = sink.push("v");
    expect(() => resolveParamSink(sink, `${token} ${token}`, (i) => `@p${i}`)).toThrow(/duplicate\/forged/);
  });

  it("throws on a forged/foreign token not recorded on this sink", () => {
    const sink = createParamSink();
    sink.push("v");
    expect(() => resolveParamSink(sink, "\u0000999\u0000", (i) => `@p${i}`)).toThrow(/forged\/foreign/);
  });

  it("throws on an orphaned token that never appears in the text", () => {
    const sink = createParamSink();
    sink.push("v");
    expect(() => resolveParamSink(sink, "no tokens here", (i) => `@p${i}`)).toThrow(/orphaned/);
  });
});
