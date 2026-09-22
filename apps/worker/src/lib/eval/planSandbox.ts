/**
 * Phase 7 Session 1 golden-suite seeding, additional to sandbox.ts's
 * connection/conversation seeding:
 *  - seedPlanWorkflow: a fresh project+workflow (empty graph, via
 *    workflow_graphs' default) per case, same fresh-per-run rationale as
 *    sandbox.ts's createConversation — a plan-propose run's PlanState is
 *    keyed off workflowId, so each case gets its own to avoid one case's
 *    proposed-but-unapplied plan context bleeding into another's.
 *  - seedHighCardinalityTable / seedHeadroomTable: originally sized (1500
 *    rows / 975 rows respectively) to straddle the OLD MAX_PLAN_AGGREGATE_
 *    ROWS=1000 hard cap and its PLAN_AGGREGATE_REFUSAL_THRESHOLD=950
 *    headroom margin, for the "aggregate-breaching-cap" /
 *    "aggregate-within-headroom-margin" golden cases (fixtures/golden/
 *    plan-v1.jsonl). Phase 13 gate correction: that flat row cap was stale
 *    (it mirrored the OLD single-chunk runtime limit Phase 9 Part 3's
 *    pushed-aggregate pagination made obsolete — see plan.ts's
 *    RESIDUAL_PLAN_AGGREGATE_GROUP_CAP doc comment). Both golden cases'
 *    prompts describe a plain no-`having` aggregate directly after a mysql
 *    source, which is ALWAYS pushed down (ops/aggregate.ts's isPushable),
 *    and a pushed aggregate has no group-count cap at all today — so
 *    neither table's row count triggers any capacity refusal anymore
 *    (both golden cases now just expect an ordinary valid plan). These
 *    seed functions are kept only so the two cases still have a real wide
 *    mysql table to aggregate over (the docker-init-seeded `employees`/
 *    `sandbox_items` tables only ever have a handful of rows) — the
 *    specific row counts (1500 / 975) no longer carry any cap-boundary
 *    significance. Seeds directly into the already-running dev-mysql
 *    container (docker exec, same direct-seed pattern as
 *    scripts/aggregate-smoke.ts's provisionMysqlSourceTable) rather than
 *    editing dev-mysql-init.sql, which only runs on a container's first
 *    boot and would require a destructive `docker compose down -v` to take
 *    effect on this already-provisioned dev machine. Idempotent
 *    (CREATE TABLE IF NOT EXISTS + INSERT IGNORE), safe on every suite run.
 *    nia_ro already has SELECT on the whole sandbox database via
 *    dev-mysql-init.sql's `GRANT SELECT ON sandbox.*` (not just the tables
 *    that existed at grant time), so this new table is queryable through
 *    the real connector without any further grant.
 */
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { env } from "../../env.js";
import { DEMO_USER_ID } from "./sandbox.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const MYSQL_CONTAINER = "nia-core-dev-mysql-1";
export const HIGH_CARDINALITY_TABLE = "plan_eval_wide";
const HIGH_CARDINALITY_ROWS = 1500;

export const HEADROOM_TABLE = "plan_eval_headroom";
// 975: no cap-boundary significance anymore (see this file's header
// comment) — kept at its original size purely for continuity.
const HEADROOM_ROWS = 975;

/**
 * Phase 13 gate follow-up: seed table for the "aggregate-residual-cap-
 * breach" golden case (fixtures/golden/plan-v1.jsonl), the case that
 * actually exercises the safety-property-scoring rule (docs/decisions.md).
 * That case's message gives the model an explicit, verbatim `having` Expr
 * JSON using `regex_extract` (unpushable on mysql, FN_PUSHABILITY —
 * packages/schemas/src/ops/types.ts) so the aggregate is forced RESIDUAL
 * regardless of dialect — a plain no-`having` aggregate (like the other two
 * cases) is always pushed and never capped post-Phase-13-fix, so it can't
 * exercise a real cap breach at all. Only 60 rows: runPlanGoldenSuite.ts
 * sets PLAN_RESIDUAL_GROUP_CAP=50 (a test-only override of plan.ts's real
 * 100,000-group RESIDUAL_PLAN_AGGREGATE_GROUP_CAP, same "override, don't
 * seed six figures of rows" convention as runEtl.ts's RESIDUAL_GROUP_CAP)
 * for exactly this reason — 60 real groups is enough to breach a 50-group
 * test cap without needing anywhere near 100,000 real rows.
 */
export const RESIDUAL_CAP_TABLE = "plan_eval_residual";
const RESIDUAL_CAP_ROWS = 60;

function mysqlExecStdin(sql: string): void {
  execFileSync("docker", ["exec", "-i", MYSQL_CONTAINER, "mysql", "-uroot", "-pdevroot", "sandbox"], { input: sql });
}

export function seedHighCardinalityTable(): void {
  const values = Array.from({ length: HIGH_CARDINALITY_ROWS }, (_, i) => `(${i + 1}, ${i + 1})`).join(",");
  mysqlExecStdin(
    `CREATE TABLE IF NOT EXISTS ${HIGH_CARDINALITY_TABLE} (id INT PRIMARY KEY, val INT NOT NULL);\n` +
      `INSERT IGNORE INTO ${HIGH_CARDINALITY_TABLE} (id, val) VALUES ${values};`,
  );
}

export function seedHeadroomTable(): void {
  const values = Array.from({ length: HEADROOM_ROWS }, (_, i) => `(${i + 1}, ${i + 1})`).join(",");
  mysqlExecStdin(
    `CREATE TABLE IF NOT EXISTS ${HEADROOM_TABLE} (id INT PRIMARY KEY, val INT NOT NULL);\n` +
      `INSERT IGNORE INTO ${HEADROOM_TABLE} (id, val) VALUES ${values};`,
  );
}

export function seedResidualCapTable(): void {
  const values = Array.from({ length: RESIDUAL_CAP_ROWS }, (_, i) => `(${i + 1}, ${i + 1})`).join(",");
  mysqlExecStdin(
    `CREATE TABLE IF NOT EXISTS ${RESIDUAL_CAP_TABLE} (id INT PRIMARY KEY, val INT NOT NULL);\n` +
      `INSERT IGNORE INTO ${RESIDUAL_CAP_TABLE} (id, val) VALUES ${values};`,
  );
}

export async function seedPlanWorkflow(orgId: string): Promise<string> {
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .insert({ org_id: orgId, name: "Copilot plan eval", created_by: DEMO_USER_ID })
    .select("id")
    .single();
  if (projErr || !project) throw new Error(`plan-eval project insert failed: ${projErr?.message}`);

  const { data: workflow, error: wfErr } = await supabase
    .from("workflows")
    .insert({ project_id: project.id as string, org_id: orgId, name: "Copilot plan eval workflow", created_by: DEMO_USER_ID })
    .select("id")
    .single();
  if (wfErr || !workflow) throw new Error(`plan-eval workflow insert failed: ${wfErr?.message}`);

  return workflow.id as string;
}
