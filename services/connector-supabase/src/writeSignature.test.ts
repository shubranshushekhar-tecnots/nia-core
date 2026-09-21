import { describe, expect, it } from "vitest";
import { signWriteContext, verifyWriteContext, WRITE_CONTEXT_MAX_AGE_MS, type WriteSignaturePayload } from "./writeSignature.js";

const SECRET = "a".repeat(32);

function payload(overrides: Partial<WriteSignaturePayload> = {}): WriteSignaturePayload {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    grantId: "22222222-2222-2222-2222-222222222222",
    runId: null,
    entity: { namespace: "sales", name: "orders" },
    columns: ["id", "total"],
    mode: "upsert",
    stagingEntity: null,
    quarantineEntity: null,
    issuedAt: Date.now(),
    ...overrides,
  };
}

describe("signWriteContext / verifyWriteContext", () => {
  it("verifies a signature it just signed", () => {
    const p = payload();
    const sig = signWriteContext(p, SECRET);
    expect(verifyWriteContext(p, sig, SECRET)).toBe(true);
  });

  it("is insensitive to column array order (columns are sorted before signing)", () => {
    const p1 = payload({ columns: ["total", "id"] });
    const p2 = payload({ ...p1, columns: ["id", "total"] });
    const sig = signWriteContext(p1, SECRET);
    expect(verifyWriteContext(p2, sig, SECRET)).toBe(true);
  });

  it("rejects a signature verified with the wrong secret", () => {
    const p = payload();
    const sig = signWriteContext(p, SECRET);
    expect(verifyWriteContext(p, sig, "b".repeat(32))).toBe(false);
  });

  it("rejects if any field is tampered with after signing", () => {
    const p = payload();
    const sig = signWriteContext(p, SECRET);
    expect(verifyWriteContext({ ...p, entity: { namespace: "sales", name: "customers" } }, sig, SECRET)).toBe(false);
    expect(verifyWriteContext({ ...p, columns: ["id", "total", "status"] }, sig, SECRET)).toBe(false);
    expect(verifyWriteContext({ ...p, connectionId: "99999999-9999-9999-9999-999999999999" }, sig, SECRET)).toBe(false);
  });

  it("rejects an expired context (older than WRITE_CONTEXT_MAX_AGE_MS)", () => {
    const p = payload({ issuedAt: Date.now() - WRITE_CONTEXT_MAX_AGE_MS - 1000 });
    const sig = signWriteContext(p, SECRET);
    expect(verifyWriteContext(p, sig, SECRET)).toBe(false);
  });

  it("rejects a context issued too far in the future (beyond clock-skew allowance)", () => {
    const p = payload({ issuedAt: Date.now() + 60_000 });
    const sig = signWriteContext(p, SECRET);
    expect(verifyWriteContext(p, sig, SECRET)).toBe(false);
  });
});
