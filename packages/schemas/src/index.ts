export * from "./manifest.js";
export * from "./tabular.js";
export * from "./contract.js";
export * from "./jobs.js";
export * from "./chat.js";
export * from "./graph.js";
export * from "./expression.js";
export * from "./nodeConfig.js";
export * from "./pushdown.js";
export type { OpKind, StepFailureReport, ResidualExecution, ResidualAccumulator } from "./ops/types.js";
export { OP_REGISTRY, opForStep } from "./ops/registry.js";
// Phase 8b-3: OnFailureAbortError is thrown by ops/onFailure.ts's
// computeFailureReport (via applyResidual) for policy "fail" — public so
// runEtl.ts can catch it specifically and convert it into a clean run
// failure instead of an unexpected-exception path.
export { OnFailureAbortError, resolveOnFailure } from "./ops/onFailure.js";
// Deliberately public (not just internal to this package's own tests):
// Phase 8b-2a's apps/worker/scripts/ops-db-conformance.ts reuses this same
// array for DB-execution assertions rather than duplicating fixture
// authoring in a parallel array — see fixtures.ts's header comment.
export { OP_FIXTURES, type OpFixture } from "./ops/__conformance__/fixtures.js";
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
export * from "./profile.js";
export { evalExpr } from "./ops/residualEval.js";
