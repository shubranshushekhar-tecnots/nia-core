import { describe, expect, it } from "vitest";
import { compilePushdown } from "../../pushdown.js";
import type { SourceDialect } from "../../pushdown.js";
import { OP_REGISTRY } from "../registry.js";
import { OP_FIXTURES } from "./fixtures.js";

const ALL_DIALECTS: SourceDialect[] = ["mysql", "postgres", "mongo"];

/**
 * Registry-driven conformance suite (Phase 8a, deliverable 3). For every
 * op in OP_REGISTRY and every dialect it declares pushable
 * (`op.isPushable(dialect)`), requires at least one fixture in
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
    const op = OP_REGISTRY[kind];
    const supportedDialects = ALL_DIALECTS.filter((d) => op.isPushable(d));

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
