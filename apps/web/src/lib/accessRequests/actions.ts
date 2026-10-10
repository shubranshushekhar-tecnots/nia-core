"use server";

import { withServiceRole } from "@nia/db";
import { getPool } from "@/lib/db/pool";
import { enqueueEmail } from "@/lib/mail/mailQueue";
import { isAuthActionRateLimited } from "@/lib/auth/rateLimit";

export type AccessRequestActionState = {
  success?: boolean;
  fieldErrors?: Record<string, string[]>;
} | null;

const DATA_SOURCE_OPTIONS = ["SQL Server", "MySQL", "PostgreSQL", "MongoDB", "Supabase", "Other"] as const;

const REQUEST_LIMIT = 5;

/**
 * Email Phase 3 — public "Request access" form submit. Every path below
 * (honeypot hit, rate-limited, duplicate pending/approved row) returns the
 * exact same generic success state as a genuinely-new request: this form
 * is reachable while signed out (middleware.ts's PUBLIC_PATHS), so none of
 * its failure modes may be distinguishable from each other without leaking
 * whether a given email has already requested access (same no-enumeration
 * posture as lib/auth/actions.ts's OTP flows).
 */
export async function submitAccessRequest(
  _prevState: AccessRequestActionState,
  formData: FormData,
): Promise<AccessRequestActionState> {
  // Hidden field real users never fill; a bot's generic form-filler will.
  if (formData.get("website")) {
    return { success: true };
  }

  const email = String(formData.get("email") ?? "").trim();
  const fullName = String(formData.get("fullName") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const jobRole = String(formData.get("jobRole") ?? "").trim();
  const useCase = String(formData.get("useCase") ?? "").trim();
  const referralSource = String(formData.get("referralSource") ?? "").trim();
  const dataSources = formData
    .getAll("dataSources")
    .map((v) => String(v))
    .filter((v): v is (typeof DATA_SOURCE_OPTIONS)[number] => (DATA_SOURCE_OPTIONS as readonly string[]).includes(v));
  const consent = formData.get("consent") === "on";

  const fieldErrors: Record<string, string[]> = {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fieldErrors.email = ["Enter a valid email address."];
  if (!fullName) fieldErrors.fullName = ["Enter your name."];
  if (!company) fieldErrors.company = ["Enter your company."];
  if (!useCase) fieldErrors.useCase = ["Tell us what you'd like to use Nia for."];
  if (!consent) fieldErrors.consent = ["You must agree to be contacted about your request."];
  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  if (await isAuthActionRateLimited("access_request", email, REQUEST_LIMIT)) {
    return { success: true };
  }

  // Dedupe: a pending/approved existing row no-ops (ON CONFLICT ... WHERE
  // only matches a rejected row), a rejected row flips back to pending so
  // the person can try again under a new submission.
  const result = await withServiceRole(getPool(), (db) =>
    db.query<{ id: string }>(
      `insert into public.access_requests
         (email, full_name, company, job_role, use_case, data_sources, referral_source)
       values (lower($1), $2, $3, $4, $5, $6, $7)
       on conflict (lower(email)) do update
         set full_name = excluded.full_name,
             company = excluded.company,
             job_role = excluded.job_role,
             use_case = excluded.use_case,
             data_sources = excluded.data_sources,
             referral_source = excluded.referral_source,
             status = 'pending',
             rejected_reason = null,
             updated_at = now()
         where access_requests.status = 'rejected'
       returning id`,
      [email, fullName, company, jobRole || null, useCase, dataSources, referralSource || null],
    ),
  );

  if (result.rows.length > 0) {
    await enqueueEmail({
      kind: "send_email",
      to: email,
      payload: { template: "accessRequestReceived", data: { requesterEmail: email } },
    });
  }

  return { success: true };
}
