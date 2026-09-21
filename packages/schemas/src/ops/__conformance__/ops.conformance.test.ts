import { describe, expect, it } from "vitest";
import { compilePushdown } from "../../pushdown.js";
import type { SourceDialect } from "../../pushdown.js";
import { getOp, OP_REGISTRY } from "../registry.js";
import { OP_FIXTURES } from "./fixtures.js";

const ALL_DIALECTS: SourceDialect[] = ["mysql", "postgres", "mongo"];

/**
 * Registry-driven conformance suite (Phase 8a, deliverable 3). For every
 * op in OP_REGISTRY and every dialect it declares pushable on its default
 * step shape (`op.isPushable(dialect, op.createDefault())`), requires at
 * least one fixture in
 * fixtures.ts — an op shipped with no fixture for a dialect it claims to
 * support fails this suite by omission rather than silently having no
 * coverage. Each fixture is then compiled for real via `compilePushdown`
 * (the same public entry point every other caller uses) and asserted
 * against its exact expected `dialectQuery` shape.
 *
 * A DB-execution harness (asserting real result rows, not just emitted
 * shape) is a named, deferred Phase 8b prerequisite — see
 * docs/decisions.md — which will consume this same OP_FIXTURES array.
 */
describe("ops conformance — every (op, supported dialect) pair has >=1 fixture", () => {
  for (const kind of Object.keys(OP_REGISTRY) as (keyof typeof OP_REGISTRY)[]) {
    // getOp (not a direct OP_REGISTRY[kind] index) so `op`'s isPushable
    // param stays TransformStep instead of collapsing to `never` — see
    // opForStep's doc comment in registry.ts for why direct indexing
    // through a union-typed key hits this.
    const op = getOp(kind);
    // isPushable's default-step check is a coarse smoke check, not a claim
    // that every fixture's specific step shape is covered — Batch 0's
    // FN_PUSHABILITY (call-fn-level pushability) only varies by the Expr
    // content a *specific* step carries (e.g. filter/computed_field/
    // aggregate.having), which createDefault()'s empty step never has.
    const supportedDialects = ALL_DIALECTS.filter((d) => op.isPushable(d, op.createDefault()));

    for (const dialect of supportedDialects) {
      it(`${kind} declares itself pushable on ${dialect} and has a fixture proving it`, () => {
        const fixtures = OP_FIXTURES.filter((f) => f.opKind === kind && f.dialect === dialect);
        expect(fixtures.length).toBeGreaterThan(0);
      });
    }
  }
});

describe("ops conformance — fixtures compile to their exact expected shape", () => {
  for (const fixture of OP_FIXTURES) {
    it(`${fixture.opKind} / ${fixture.dialect}: ${fixture.description}`, () => {
      const plan = compilePushdown(fixture.dialect, fixture.config);
      expect(plan.dialectQuery).toEqual(fixture.expectedDialectQuery);
    });
  }
});

/**
 * Phase 8b-2, batch 0 remainder: guards sqlShared.ts's `CAST(x AS type)`
 * workaround (see its doc comment, ~line 128) against silent regression.
 * `::` is postgres shorthand cast syntax; guardrails' SQL validator
 * tokenizes it into two bogus tokens and rejects the query at dispatch
 * time (verified live, Phase 8b-2b), so every dialect adapter must always
 * emit the portable `CAST(...)` form instead — never `::`. Checked against
 * every fixture's *actual* compiled output (not just `expectedDialectQuery`
 * literals), so a future op/adapter change that reintroduces `::` fails
 * here even if someone updates the fixture's expected string to match.
 */
describe("ops conformance — no emitted SQL ever contains `::`", () => {
  for (const fixture of OP_FIXTURES) {
    if (fixture.dialect === "mongo") continue;
    it(`${fixture.opKind} / ${fixture.dialect}: ${fixture.description}`, () => {
      const plan = compilePushdown(fixture.dialect, fixture.config);
      const sql = plan.dialectQuery;
      const emitted = sql && "whereSql" in sql ? [sql.whereSql, sql.selectSql, sql.havingSql].filter((s): s is string => s !== null).join(" ") : "";
      expect(emitted.includes("::")).toBe(false);
    });
  }
});
