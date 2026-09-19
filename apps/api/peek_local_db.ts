import { createClient } from "@supabase/supabase-js";

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: workflows, error: wErr } = await supabase
    .from("workflows")
    .select("id, name, org_id, owner_id")
    .order("created_at", { ascending: false })
    .limit(10);
  console.log("workflows:", JSON.stringify(workflows, null, 2), wErr);

  const { data: graphs, error: gErr } = await supabase.from("workflow_graphs").select("workflow_id, version").limit(10);
  console.log("workflow_graphs:", JSON.stringify(graphs, null, 2), gErr);
}

main().then(() => process.exit(0));
