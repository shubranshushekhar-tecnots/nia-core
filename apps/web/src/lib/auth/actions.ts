"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { z } from "zod";
import { APIError } from "better-auth/api";
import { withActingUser } from "@nia/db";
import { auth } from "@/lib/auth/auth";
import { getSessionUser } from "@/lib/auth/session";
import { dbPool } from "@/lib/db/pool";

export type ActionState = {
  error?: string;
  // Item 5 (fix-chain plan): raw driver/connector text behind a "Show
  // details" toggle, set alongside a friendlier `error` summary by actions
  // that surface connector test/refresh errors (see connections/actions.ts's
  // friendlyApiErrorMessage). Additive/optional so auth actions (which never
  // set it) are unaffected.
  errorDetails?: string;
  fieldErrors?: Record<string, string[]>;
  success?: boolean;
  // Set by login/signup only: the raw session token (docs/plans/auth.md) —
  // Better Auth's session cookie is httpOnly, so the client can't read it
  // itself. LoginForm/SignupForm store this via lib/auth/browserSession.ts
  // then navigate to `next`, instead of the Server Action redirecting
  // directly — the cookie is already set by then (nextCookies() plugin,
  // lib/auth/auth.ts), this is purely for the Bearer-token client
  // fetches (lib/api/*Client.ts).
  token?: string;
  next?: string;
} | null;

function safeNext(next: FormDataEntryValue | null): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

const loginSchema = z.object({
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(1, "Password is required"),
});

export async function login(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  let token: string;
  try {
    const result = await auth.api.signInEmail({ body: parsed.data, headers: await headers() });
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      // Deliberately vague: never reveal whether the account exists.
      return { error: "Invalid email or password." };
    }
    throw err;
  }

  revalidatePath("/", "layout");
  return { success: true, token, next: safeNext(formData.get("next")) };
}

const signupSchema = z.object({
  fullName: z.string().min(1, "Name is required"),
  email: z.string().email("Enter a valid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function signup(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signupSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  let token: string;
  try {
    const result = await auth.api.signUpEmail({
      body: { email: parsed.data.email, password: parsed.data.password, name: parsed.data.fullName },
      headers: await headers(),
    });
    // autoSignIn (packages/auth/src/config.ts) means this is only null if
    // email verification were required (it isn't — see config), so this
    // should never happen in practice; typed as nullable regardless.
    if (!result.token) return { error: "Something went wrong. Try again." };
    token = result.token;
  } catch (err) {
    if (err instanceof APIError) {
      return { error: err.message || "Something went wrong. Try again." };
    }
    throw err;
  }

  // autoSignIn (packages/auth/src/config.ts) means this is already a real
  // session, and there's no email-confirmation step — signup behaves like
  // an immediate login straight into the app.
  return { success: true, token, next: "/app" };
}

export async function logout(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  revalidatePath("/", "layout");
  redirect("/login");
}

const onboardingSchema = z.object({
  name: z.string().min(1, "Organization name is required"),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and hyphens only"),
});

export async function createOrganization(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = onboardingSchema.safeParse({
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    return { fieldErrors: parsed.error.flatten().fieldErrors };
  }

  const user = await getSessionUser();
  if (!user) return { error: "Your session expired — sign in again." };

  let orgId: string;
  try {
    const result = await withActingUser(dbPool, user.id, (db) =>
      db.query<{ create_organization: string }>("select public.create_organization($1, $2)", [
        parsed.data.name,
        parsed.data.slug,
      ]),
    );
    orgId = result.rows[0]!.create_organization;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Something went wrong. Try again." };
  }

  revalidatePath("/", "layout");
  redirect(`/app?org=${orgId}`);
}
