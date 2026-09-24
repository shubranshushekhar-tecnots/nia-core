"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
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

  const supabase = await createClient();
  const { error } = await supabase.from("sales_leads").insert({
    name: parsed.data.name,
    work_email: parsed.data.workEmail,
    company: parsed.data.company,
    team_size: parsed.data.teamSize ?? null,
    message: parsed.data.message ?? null,
  });
  if (error) {
    return { error: "Something went wrong sending your request. Please try again." };
  }

  return { success: true };
}
