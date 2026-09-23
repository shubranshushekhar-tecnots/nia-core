import { describe, it, expect } from "vitest";
import { applyConformance } from "./conformance.js";
import type { DestinationContract } from "../destinationContract.js";

/**
 * Bug fix: pg/mysql2/mongodb all deserialize a real date/timestamp column
 * into a genuine JS `Date` before this cast ever runs, but the conformance
 * cast's `to_date` coercion used to reject any non-string input outright —
 * so every non-null value in a date/timestamp destination column was
 * treated as a coercion failure, quarantining every row of even a plain,
 * transform-free copy. This is what runEtl.ts calls unconditionally on
 * every chunk (see its "Always run" comment), so it's the actual runtime
 * path a real ETL run exercises, not just residualEval's own unit level.
 */
describe("applyConformance", () => {
  const contract: DestinationContract = {
    columns: [
      { destinationName: "id", niaType: { kind: "integer" }, isKey: true },
      { destinationName: "created_at", niaType: { kind: "timestamp" }, isKey: false },
    ],
    unknownFieldPolicy: "ignore",
  } as unknown as DestinationContract;

  it("does not quarantine a real Date value in a timestamp column (plain copy, no transform)", () => {
    const rows = [
      [1, new Date("2024-01-15T10:30:00Z")],
      [2, new Date("2024-06-01T00:00:00Z")],
    ];

    const result = applyConformance(["id", "created_at"], rows, contract);

    expect(result.failures.filter((f) => f.count > 0)).toEqual([]);
    expect(result.rows).toEqual([
      [1, "2024-01-15T10:30:00Z"],
      [2, "2024-06-01T00:00:00Z"],
    ]);
  });

  it("still quarantines a genuinely unparseable value in a timestamp column", () => {
    const rows = [[1, "not a date"]];

    const result = applyConformance(["id", "created_at"], rows, contract);

    const failure = result.failures.find((f) => f.count > 0);
    expect(failure?.count).toBe(1);
  });

  // Lean test 1: a column kind with no fallible coercion function (e.g.
  // `string`) is skipped entirely — no report is emitted for it at all,
  // not even a zero-count one. This is the real "skip" mechanism
  // (CONFORMANCE_CAST_FN has no entry for that NiaTypeKind); there is no
  // separate source-type-vs-contract-type comparison anywhere in this
  // module (the contract's niaType is always structurally derived from
  // the source schema by construction — see destinationContract.ts — so
  // a literal "types match" check would trivially skip every column,
  // defeating conformance's purpose as a real value-shape check).
  it("emits no report at all for a column kind with no cast function (e.g. string)", () => {
    const stringContract: DestinationContract = {
      columns: [
        { destinationName: "id", niaType: { kind: "integer" }, isKey: true },
        { destinationName: "label", niaType: { kind: "string" }, isKey: false },
      ],
      unknownFieldPolicy: "ignore",
    } as unknown as DestinationContract;

    const result = applyConformance(["id", "label"], [[1, "anything at all"]], stringContract);

    expect(result.failures.some((f) => f.label.includes("label"))).toBe(false);
  });

  // Lean test 2: a `timestamp`-kind column now casts via `to_timestamp`,
  // not `to_date` — proven by millisecond precision surviving the cast.
  // `to_date` has always truncated fractional seconds; only `to_timestamp`
  // preserves them (see residualEval.ts's evalCoercionFn cases).
  it("casts a timestamp column with a timestamp conversion that preserves millisecond precision, not to_date", () => {
    const rows = [[1, new Date("2026-09-22T10:09:40.918Z")]];

    const result = applyConformance(["id", "created_at"], rows, contract);

    expect(result.failures.filter((f) => f.count > 0)).toEqual([]);
    expect(result.rows).toEqual([[1, "2026-09-22T10:09:40.918Z"]]);
  });
});
