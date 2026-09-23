import { describe, it, expect } from "vitest";
import { resolveTableFieldState } from "./tableFieldState.js";

describe("resolveTableFieldState", () => {
  it("renders the picker (not stuck loading) for a connected, successfully-introspected but genuinely empty database", () => {
    const state = resolveTableFieldState({
      connectionId: "conn-1",
      newTargetMode: false,
      isLoading: false,
      isError: false,
      errorMessage: null,
    });
    expect(state).toEqual({ kind: "select" });
  });

  it("shows loading only while the schema fetch is actually in flight", () => {
    const state = resolveTableFieldState({
      connectionId: "conn-1",
      newTargetMode: false,
      isLoading: true,
      isError: false,
      errorMessage: null,
    });
    expect(state).toEqual({ kind: "loading" });
  });

  it("surfaces the introspection error to the user instead of silently showing loading", () => {
    const state = resolveTableFieldState({
      connectionId: "conn-1",
      newTargetMode: false,
      isLoading: false,
      isError: true,
      errorMessage: "Connection refused",
    });
    expect(state).toEqual({ kind: "error", message: "Connection refused" });
  });

  it("prompts for a connection before any fetch has started", () => {
    const state = resolveTableFieldState({
      connectionId: undefined,
      newTargetMode: false,
      isLoading: false,
      isError: false,
      errorMessage: null,
    });
    expect(state).toEqual({ kind: "select-connection" });
  });

  it("stays in new-target mode even while the schema is loading/erroring, once the user has opted in", () => {
    const state = resolveTableFieldState({
      connectionId: "conn-1",
      newTargetMode: true,
      isLoading: true,
      isError: true,
      errorMessage: "boom",
    });
    expect(state).toEqual({ kind: "new-target" });
  });
});
