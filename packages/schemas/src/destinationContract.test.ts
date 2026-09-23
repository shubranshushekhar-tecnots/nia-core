import { describe, it, expect } from "vitest";
import { compareContractToExisting, type DestinationContract } from "./destinationContract.js";

function postgresContract(nativeType: string): DestinationContract {
  return {
    dialect: "postgres",
    entity: { namespace: "public", name: "widgets" },
    unknownFieldPolicy: "count",
    columns: [
      {
        sourcePath: "created_at",
        destinationName: "created_at",
        niaType: { kind: "timestamp", tz: "utc" },
        nativeType,
        fidelity: { kind: "lossless" },
        isKey: false,
        nullable: true,
        nestedFieldStrategy: "json",
      },
    ],
  };
}

describe("compareContractToExisting — type identity, not string equality", () => {
  it("matches postgres's timestamptz alias against the contract's TIMESTAMPTZ", () => {
    const contract = postgresContract("TIMESTAMPTZ");
    const result = compareContractToExisting(contract, {
      fields: [{ name: "created_at", type: "timestamp with time zone" }],
    });
    expect(result.ok).toBe(true);
  });

  it("still reports a real mismatch: integer vs BIGINT", () => {
    const contract = postgresContract("BIGINT");
    const result = compareContractToExisting(contract, {
      fields: [{ name: "created_at", type: "integer" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const [diff] = result.diffs;
      expect(diff?.kind).toBe("type-mismatch");
      expect(diff?.alterStatement).toContain("ALTER TABLE");
      expect(diff?.alterStatement).toContain("BIGINT");
    }
  });
});
