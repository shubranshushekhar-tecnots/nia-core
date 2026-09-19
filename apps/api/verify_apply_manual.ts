// One-off manual verification script for Phase 7 Session 2's Apply path —
// NOT part of the committed test suite (no seeded browser-login test
// account exists via the web UI's Playwright flow in this shell session,
// per CLAUDE.md's own documented e2e constraint) — but this signs in as
// the real demo@nia.dev user via signInWithPassword and builds a client
// from that session's access token, so applyPlan() runs through the exact
// same RLS-scoped path the real route uses (req.supabase = a per-request
// client built from the caller's own JWT, not service_role), including a
// real auth.uid() for log_plan_applied()'s private.can_access_workflow()
// check.
// Run: cd apps/api && npx tsx verify_apply_manual.ts   (reads SUPABASE_URL/ANON_KEY from apps/api/.env via dotenv/config)
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { applyPlan } from "./src/services/copilotApply.js";

// "ETL kill-resume smoke" — the real dev-server workflow used by other
// throwaway verification scripts in this repo (see apps/web/run_workflow.mjs),
// owned by the demo org (org_members role "owner" for demo@nia.dev).
const WORKFLOW_ID = "bbe6e6ad-97cd-444b-9219-d0020de88d28";
const ORG_ID = "bf5ee29f-d97a-4857-84c0-9aae3b38f567";

async function main() {
  const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!);
  const { data: authData, error: authError } = await anon.auth.signInWithPassword({
    email: "demo@nia.dev",
    password: "password",
  });
  if (authError || !authData.session) throw new Error(`sign-in failed: ${authError?.message}`);

  // Same construction req.supabase uses per-request: anon key + the caller's own access token.
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${authData.session.access_token}` } },
  });
  const scope = { orgId: ORG_ID };

  const { data: current } = await supabase
    .from("workflow_graphs")
    .select("version")
    .eq("workflow_id", WORKFLOW_ID)
    .maybeSingle();
  const baseGraphVersion = current?.version ?? 0;
  console.log("observed current version (via RLS-scoped client):", baseGraphVersion);

  const plan = {
    summary: "Phase 7 Session 2 manual verification (this window, real user session): add a standalone source node",
    nodes: [{ id: "verify-real-session", type: "source" as const, config: {}, position: { x: 0, y: 0 } }],
    edges: [],
    probeResults: [],
    baseGraphVersion,
  };

  const result = await applyPlan(supabase, scope, WORKFLOW_ID, {
    plan,
    prompt: "manual verification run (this window, real user session)",
  });
  console.log("applyPlan result:", JSON.stringify({ version: result.version, appliedNodeIds: result.appliedNodeIds }, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("applyPlan FAILED:", err);
    process.exit(1);
  },
);
