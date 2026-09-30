"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withActingUser } from "@nia/db";
import { assertCan, PermissionError } from "@nia/schemas";
import { requireUser, requireUserWithOrg } from "@/lib/auth/session";
import { getPool } from "@/lib/db/pool";
import type { ActionState } from "@/lib/auth/actions";

// Settings page (Phase 1). Two thin Server Actions over already-granted RLS
// capabilities — same shape/error-mapping convention as members/actions.ts
// (friendly*Error, assertCan() short-circuit before the DB call, rowCount
// check for a silent RLS rejection, revalidatePath on success). No new DB
// grants/policies: profiles.full_name (profiles_update_own,
// 0001_auth_orgs.sql) and organizations.name/slug
// (organizations_update_admins + the column grant in 0061_billing_owner.sql)
// were both already writable by the acting user before this file existed.

function friendlySettingsError(err: unknown): string {
  if (err instanceof PermissionError) return err.message;
  if (isUniqueViolation(err)) return "That slug is already taken.";
  if (err instanceof Error) return err.message;
  return "Something went wrong. Try again.";
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

const profileNameSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(120, "Name must be 120 characters or fewer"),
});

export async function updateProfileName(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = profileNameSchema.safeParse({ fullName: formData.get("fullName") });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const user = await requireUser();

  try {
    await withActingUser(getPool(), user.userId, (db) =>
      db.query("update public.profiles set full_name = $1 where id = $2", [parsed.data.fullName, user.userId]),
    );
  } catch (err) {
    return { error: friendlySettingsError(err) };
  }

  revalidatePath("/app/settings");
  return { success: true };
}

// Reuses the exact onboarding slug regex/message (auth/actions.ts's
// onboardingSchema) so the two forms never disagree on what a valid slug is.
const organizationSchema = z.object({
  name: z.string().trim().min(1, "Organization name is required"),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens only"),
});

export async function updateOrganization(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = organizationSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };

  const user = await requireUserWithOrg();

  try {
    assertCan(user.role, "org.update");
  } catch (err) {
    return { error: friendlySettingsError(err) };
  }

  try {
    const result = await withActingUser(getPool(), user.userId, (db) =>
      db.query("update public.organizations set name = $1, slug = $2 where id = $3", [
        parsed.data.name,
        parsed.data.slug,
        user.org.id,
      ]),
    );
    if (result.rowCount === 0) return { error: "Couldn't update organization. Try again." };
  } catch (err) {
    return { error: friendlySettingsError(err) };
  }

  revalidatePath("/app/settings");
  revalidatePath("/", "layout");
  return { success: true };
}
