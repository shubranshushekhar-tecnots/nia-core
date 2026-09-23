import { describe, expect, it, vi } from "vitest";

/**
 * Closes the remaining link in the fail-closed probe chain:
 * validateFeasibility.test.ts proves the node wiring refuses when
 * probeCardinality returns a negative count; this proves probeCardinality
 * itself returns a negative count (never throws, never returns 0) when the
 * real dispatch() call fails — guardrail rejection, connector error, or
 * PLAN_PROBE_TIMEOUT_MS exceeded. Mocks only dispatch.js, same boundary
 * runPreview.test.ts mocks at.
 */

const dispatchMock = vi.fn();
vi.mock("../dispatch.js", () => ({ dispatch: (...args: unknown[]) => dispatchMock(...args) }));

const { probeCardinality } = await import("./probeCardinality.js");

const CONNECTION_ID = "11111111-1111-1111-1111-111111111111";
const SCOPE = { orgId: "org-1" };
const USER_ID = "44444444-4444-4444-4444-444444444444";
const ENTITY = { namespace: "public", name: "employees" };

describe("probeCardinality", () => {
  it("returns a negative sentinel (never throws) when dispatch fails (e.g. guardrail-rejected)", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { kind: "guardrail-rejected", message: "nope" } });

    const count = await probeCardinality(CONNECTION_ID, ENTITY, ["id"], "mysql", SCOPE, USER_ID);

    expect(count).toBeLessThan(0);
  });

  it("returns a negative sentinel when dispatch fails with a connection-not-found error", async () => {
    dispatchMock.mockResolvedValue({ ok: false, error: { kind: "connection-not-found", message: "gone" } });

    const count = await probeCardinality(CONNECTION_ID, ENTITY, ["id"], "mysql", SCOPE, USER_ID);

    expect(count).toBeLessThan(0);
  });

  it("returns a negative sentinel when the dispatched result isn't a numeric count", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { rows: [[undefined]], columns: ["c"] } });

    const count = await probeCardinality(CONNECTION_ID, ENTITY, ["id"], "mysql", SCOPE, USER_ID);

    expect(count).toBeLessThan(0);
  });

  it("returns the real count on a successful dispatch, and passes a bounded timeoutMs through to dispatch", async () => {
    dispatchMock.mockResolvedValue({ ok: true, value: { rows: [[7]], columns: ["c"] } });

    const count = await probeCardinality(CONNECTION_ID, ENTITY, ["id"], "mysql", SCOPE, USER_ID);

    expect(count).toBe(7);
    const lastCall = dispatchMock.mock.calls[dispatchMock.mock.calls.length - 1];
    const opts = lastCall?.[4] as { rowCap?: number; timeoutMs?: number };
    expect(opts.rowCap).toBe(1);
    expect(opts.timeoutMs).toBeGreaterThan(0);
    expect(opts.timeoutMs).toBeLessThanOrEqual(15000); // must stay under connectorClient.ts's DEFAULT_TIMEOUT_MS
  });
});
