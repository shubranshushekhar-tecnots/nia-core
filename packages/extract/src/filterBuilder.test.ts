import { describe, expect, it } from "vitest";
import { resolveTable } from "./catalog.js";
import { compileWhereClause, escapeLikeWildcards, InvalidFilterError, UnknownColumnError, UnknownOperatorError, validateExtractRequest } from "./filterBuilder.js";
import { createParamSink, resolveParamSink } from "./paramSink.js";
import type { Catalog, FilterCondition } from "./types.js";

const catalog: Catalog = {
  generatedAt: "2024-01-01T00:00:00.000Z",
  sourceTimeZone: "UTC",
  tables: [
    {
      name: "dbo.orders",
      kind: "table",
      columns: [
        { name: "id", type: "number", nullable: false },
        { name: "customer", type: "text", nullable: true },
        { name: "placed_at", type: "datetime", nullable: false },
      ],
      excluded: [],
      primaryKey: ["id"],
    },
  ],
};

const bracketAdapter = { quoteIdent: (name: string) => `[${name.replace(/]/g, "]]")}]`, likeEscapeChar: "\\" };

function compile(filter: FilterCondition[]) {
  const sink = createParamSink();
  const fragments = compileWhereClause(filter, bracketAdapter, sink);
  return resolveParamSink(sink, fragments.join(" AND "), (i) => `@p${i}`);
}

describe("validateExtractRequest", () => {
  it("accepts a request whose table/columns/filter columns all resolve", () => {
    const { table, columns } = validateExtractRequest(catalog, {
      table: "dbo.orders",
      columns: ["id", "customer"],
      filter: [{ column: "placed_at", operator: "isNotNull" }],
    });
    expect(table.name).toBe("dbo.orders");
    expect(columns).toEqual(["id", "customer"]);
  });

  it("defaults to every catalog column when columns is empty", () => {
    const { columns } = validateExtractRequest(catalog, { table: "dbo.orders", columns: [], filter: [] });
    expect(columns).toEqual(["id", "customer", "placed_at"]);
  });

  it("rejects an unknown table", () => {
    expect(() => validateExtractRequest(catalog, { table: "dbo.nope", columns: [], filter: [] })).toThrow();
  });

  it("rejects an unknown filter column even if it's not in `columns`", () => {
    expect(() =>
      validateExtractRequest(catalog, { table: "dbo.orders", columns: ["id"], filter: [{ column: "nope", operator: "isNull" }] }),
    ).toThrow(UnknownColumnError);
  });

  it("rejects an unknown operator", () => {
    const bad = { column: "id", operator: "sqlInject", value: 1 } as unknown as FilterCondition;
    expect(() => validateExtractRequest(catalog, { table: "dbo.orders", columns: [], filter: [bad] })).toThrow(UnknownOperatorError);
  });

  it("rejects an \"in\" filter over the 1000-value limit", () => {
    const values = Array.from({ length: 1001 }, (_, i) => i);
    const cond: FilterCondition = { column: "id", operator: "in", values };
    expect(() => validateExtractRequest(catalog, { table: "dbo.orders", columns: [], filter: [cond] })).toThrow(InvalidFilterError);
  });
});

describe("compileWhereClause", () => {
  it("compiles every operator to parameterized SQL, never inlining a value", () => {
    const { sql, params } = compile([
      { column: "id", operator: "eq", value: 5 },
      { column: "id", operator: "between", low: 1, high: 10 },
      { column: "id", operator: "in", values: [1, 2, 3] },
      { column: "customer", operator: "startsWith", value: "Ac" },
      { column: "placed_at", operator: "isNull" },
      { column: "placed_at", operator: "isNotNull" },
    ]);
    expect(sql).toBe(
      "[id] = @p1 AND [id] BETWEEN @p2 AND @p3 AND [id] IN (@p4, @p5, @p6) AND [customer] LIKE @p7 ESCAPE '\\' AND [placed_at] IS NULL AND [placed_at] IS NOT NULL",
    );
    expect(params).toEqual([5, 1, 10, 1, 2, 3, "Ac%"]);
  });

  it("never lets a hostile value escape as raw SQL text — always bound as a param", () => {
    const { sql, params } = compile([{ column: "customer", operator: "eq", value: "x'; DROP TABLE orders; --" }]);
    expect(sql).not.toContain("DROP TABLE");
    expect(params).toEqual(["x'; DROP TABLE orders; --"]);
  });
});

describe("escapeLikeWildcards", () => {
  it("escapes % and _ so they match literally", () => {
    expect(escapeLikeWildcards("50%_off")).toBe("50\\%\\_off");
  });

  it("escapes a literal escape char in the value first", () => {
    expect(escapeLikeWildcards("a\\b%c")).toBe("a\\\\b\\%c");
  });
});
