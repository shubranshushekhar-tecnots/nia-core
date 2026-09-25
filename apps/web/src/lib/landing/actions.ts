"use server";

import { z } from "zod";
import { dbPool } from "@/lib/db/pool";
import type { ActionState } from "@/lib/auth/actions";

const talkToSalesSchema = z.object({
  name: z.string().min(1, "Name is required"),
  workEmail: z.string().email("Enter a valid work email"),
  company: z.string().min(1, "Company is required"),
  teamSize: z.string().optional(),
  message: z.string().optional(),
});

export async function submitTalkToSales(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = talkToSalesSchema.safeParse({
    name: formData.get("name"),
    workEmail: formData.get("workEmail"),
    company: formData.get("company"),
    teamSize: formData.get("teamSize") || undefined,
    message: formData.get("message") || undefined,
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  // Unauthenticated (no session yet, this is the public landing page) —
  // insert directly via dbPool, which connects as the `postgres` role and
  // so bypasses RLS the same way the old anon-key Supabase client's
  // `with check (true)` policy (0034_sales_leads.sql) allowed anyway.
  try {
    await dbPool.query(
      `insert into public.sales_leads (name, work_email, company, team_size, message)
       values ($1, $2, $3, $4, $5)`,
      [parsed.data.name, parsed.data.workEmail, parsed.data.company, parsed.data.teamSize ?? null, parsed.data.message ?? null],
    );
  } catch {
    return { error: "Something went wrong sending your request. Please try again." };
  }

  return { success: true };
}
