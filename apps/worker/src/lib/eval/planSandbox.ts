/**
 * Phase 7 Session 1 golden-suite seeding, additional to sandbox.ts's
 * connection/conversation seeding:
 *  - seedPlanWorkflow: a fresh project+workflow (empty graph, via
 *    workflow_graphs' default) per case, same fresh-per-run rationale as
 *    sandbox.ts's createConversation — a plan-propose run's PlanState is
 *    keyed off workflowId, so each case gets its own to avoid one case's
 *    proposed-but-unapplied plan context bleeding into another's.
 *  - seedHighCardinalityTable: the docker-init-seeded `employees`/
 *    `sandbox_items` tables (docker/dev-mysql-init.sql) only ever have a
 *    handful of rows — nowhere near MAX_PLAN_AGGREGATE_ROWS (1000), so the
 *    "aggregate-breaching-cap" golden case has nothing real to breach the
 *    cap against. This seeds a wide mysql table directly into the already-
 *    running dev-mysql container (docker exec, same direct-seed pattern as
 *    scripts/aggregate-smoke.ts's provisionMysqlSourceTable) rather than
 *    editing dev-mysql-init.sql, which only runs on a container's first
 *    boot and would require a destructive `docker compose down -v` to take
 *    effect on this already-provisioned dev machine. Idempotent
 *    (CREATE TABLE IF NOT EXISTS + INSERT IGNORE), safe on every suite run.
 *    nia_ro already has SELECT on the whole sandbox database via
 *    dev-mysql-init.sql's `GRANT SELECT ON sandbox.*` (not just the tables
 *    that existed at grant time), so this new table is queryable through
 *    the real connector without any further grant.
 *  - seedHeadroomTable: same rationale as seedHighCardinalityTable, but
 *    sized to land strictly between PLAN_AGGREGATE_REFUSAL_THRESHOLD (950)
 *    and MAX_PLAN_AGGREGATE_ROWS (1000) — the "aggregate-breaching-cap"
 *    table (1500 rows) only exercises the hard-breach refusal path; this
 *    one exercises the headroom-margin refusal path (under the hard cap,
 *    but still refused) as its own distinct golden case.
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
// 975: > PLAN_AGGREGATE_REFUSAL_THRESHOLD (950), <= MAX_PLAN_AGGREGATE_ROWS
// (1000) — lands inside the headroom margin, not a hard breach.
const HEADROOM_ROWS = 975;

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
