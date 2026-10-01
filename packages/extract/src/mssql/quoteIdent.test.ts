import { describe, expect, it } from "vitest";
import { quoteIdent, quoteQualifiedName } from "./quoteIdent.js";

describe("quoteIdent", () => {
  it("brackets a plain identifier", () => {
    expect(quoteIdent("orders")).toBe("[orders]");
  });

  it("doubles a literal ] inside the identifier", () => {
    expect(quoteIdent("weird]name")).toBe("[weird]]name]");
  });

  it("neutralizes an attempted bracket-escape injection", () => {
    // A hostile name trying to close the bracket early and inject SQL.
    const hostile = "x]; DROP TABLE orders; --";
    const quoted = quoteIdent(hostile);
    expect(quoted).toBe("[x]]; DROP TABLE orders; --]");
    // Still a single bracketed identifier: only one opening and one real closing bracket pair.
    expect(quoted.startsWith("[")).toBe(true);
    expect(quoted.endsWith("]")).toBe(true);
  });
});

describe("quoteQualifiedName", () => {
  it("quotes schema and table separately", () => {
    expect(quoteQualifiedName("dbo.orders")).toBe("[dbo].[orders]");
  });

  it("quotes a bare name (no schema) as a single identifier", () => {
    expect(quoteQualifiedName("orders")).toBe("[orders]");
  });

  it("splits only on the first dot, treating the rest as part of the table name", () => {
    expect(quoteQualifiedName("dbo.vw_sales.region")).toBe("[dbo].[vw_sales.region]");
  });
});
