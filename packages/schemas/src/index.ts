export * from "./manifest.js";
export * from "./tabular.js";
export * from "./contract.js";
export * from "./jobs.js";
export * from "./chat.js";
export * from "./graph.js";
export * from "./expression.js";
export * from "./nodeConfig.js";
export * from "./pushdown.js";
export type { OpKind, StepFailureReport, QuarantinedRow, ResidualExecution, ResidualAccumulator, SchemaResult } from "./ops/types.js";
export { OP_REGISTRY, opForStep, compileTransformOutputSchema } from "./ops/registry.js";
// Phase 8b-3: OnFailureAbortError is thrown by ops/onFailure.ts's
// computeFailureReport (via applyResidual) for policy "fail" — public so
// runEtl.ts can catch it specifically and convert it into a clean run
// failure instead of an unexpected-exception path. ResidualAbortError
// (Schema-layer Part 3 follow-up) is OnFailureAbortError's base class,
// for ops whose applyResidual needs the same clean-abort treatment but
// isn't Expr/CallFn-shaped (e.g. flatten.ts's non-object-row case) —
// runEtl.ts catches this base class, not just the OnFailureAbortError
// subclass, so both routes land in the same failStaged path.
export { OnFailureAbortError, ResidualAbortError, resolveOnFailure } from "./ops/onFailure.js";
// Deliberately public (not just internal to this package's own tests):
// Phase 8b-2a's apps/worker/scripts/ops-db-conformance.ts reuses this same
// array for DB-execution assertions rather than duplicating fixture
// authoring in a parallel array — see fixtures.ts's header comment.
export { OP_FIXTURES, type OpFixture } from "./ops/__conformance__/fixtures.js";
export { applyConformance } from "./ops/conformance.js";
export * from "./residualTransform.js";
export * from "./runEvents.js";
export * from "./checks.js";
export * from "./mappingProposal.js";
export * from "./entityResolution.js";
export * from "./previewResult.js";
export * from "./can.js";
export * from "./audit.js";
export * from "./connectors/mysql.js";
export * from "./connectors/mongodb.js";
export * from "./connectors/supabase.js";
export * from "./connectors/registry.js";
export * from "./writeGrantStatement.js";
export * from "./plan.js";
export * from "./planDiff.js";
export * from "./profile.js";
export * from "./cleanPlan.js";
export * from "./cleanPropose.js";
export { evalExpr } from "./ops/residualEval.js";
export * from "./niaType.js";
export * from "./niaAdapters.js";
export * from "./niaInference.js";
// Namespaced, not `export *`: this file's typeOfExpr(expr, input) => NiaType
// would otherwise collide with expression.ts's already-exported, differently-
// purposed typeOfExpr(expr) => "scalar" | "boolean" grammar classifier. See
// docs/plans/schema-layer.md's Part 3 plan-update entry.
export * as niaExprType from "./niaExprType.js";
export * from "./writeValueCoercion.js";
export * from "./destinationContract.js";
export * from "./connectionErrorMessages.js";
