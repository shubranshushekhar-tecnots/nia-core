import { createClient } from "@supabase/supabase-js";
const supabase = createClient(
  "http://127.0.0.1:54321",
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  { auth: { autoRefreshToken: false, persistSession: false } }
);
const { data, error } = await supabase.auth.admin.generateLink({
  type: "magiclink",
  email: "testuser1@gmail.com",
  options: { redirectTo: "http://localhost:3100/app" },
});
if (error) { console.error("ERR", error); process.exit(1); }
console.log(data.properties.action_link);
