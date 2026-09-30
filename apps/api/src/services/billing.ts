import type { WithUser } from "../lib/withUser.js";
import { createRazorpaySubscription } from "../lib/razorpay.js";
import { env } from "../env.js";

/**
 * Subscription Phase 4, Slice 2 (docs/plans/subscription-model.md) —
 * individual Free/Legacy -> Pro checkout. Deliberately individual-only:
 * every query here reads/writes owner_plan (never org_plan) and every RPC
 * call is create_individual_subscription (0065_subscription_webhook_rpc.sql)
 * — org billing checkout is a future slice's concern. Plan changes
 * themselves never happen in this file: create_individual_subscription()
 * only ever inserts a status='incomplete' row; owner_plan.plan_id is
 * updated exclusively by apply_subscription_webhook() (routes/
 * billingWebhook.ts), per the slice's own "plan changes only on the
 * webhook, never the checkout redirect" instruction.
 */

export type UpgradeWarning = {
  field: "projectLimit" | "workflowLimit";
  current: number | null;
  upgraded: number | null;
};

export type UpgradePreview = {
  currentPlanId: string;
  currentPlanName: string;
  proPlanName: string;
  monthlyAvailable: boolean;
  yearlyAvailable: boolean;
  /** Non-empty when Pro would LOWER a limit the user currently has (e.g. Legacy's unlimited projects -> Pro's 5) — surfaced as a pre-checkout warning. */
  warnings: UpgradeWarning[];
};

type UpgradePreviewRow = {
  current_plan_id: string;
  current_plan_name: string;
  current_project_limit: number | null;
  current_workflow_limit: number | null;
  pro_plan_name: string;
  pro_project_limit: number | null;
  pro_workflow_limit: number | null;
};

/** null = unlimited; a lower (non-null, smaller) number, or unlimited -> limited at all, counts as a downgrade. */
function isDowngrade(current: number | null, upgraded: number | null): boolean {
  if (upgraded === null) return false;
  if (current === null) return true;
  return upgraded < current;
}

export async function getUpgradePreview(withUser: WithUser, userId: string): Promise<UpgradePreview> {
  const { rows } = await withUser((db) =>
    db.query<UpgradePreviewRow>(
      `select
         op.plan_id as current_plan_id,
         cur.name as current_plan_name,
         case when op.project_limit_set then op.project_limit else cur.project_limit end as current_project_limit,
         case when op.workflow_limit_set then op.workflow_limit else cur.workflow_limit end as current_workflow_limit,
         pro.name as pro_plan_name,
         pro.project_limit as pro_project_limit,
         pro.workflow_limit as pro_workflow_limit
       from public.owner_plan op
       join public.plans cur on cur.id = op.plan_id
       cross join (select name, project_limit, workflow_limit from public.plans where id = 'pro') pro
       where op.user_id = $1`,
      [userId],
    ),
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`no owner_plan row for user ${userId} — every user gets one via the signup trigger (0051)`);
  }

  const warnings: UpgradeWarning[] = [];
  if (isDowngrade(row.current_project_limit, row.pro_project_limit)) {
    warnings.push({ field: "projectLimit", current: row.current_project_limit, upgraded: row.pro_project_limit });
  }
  if (isDowngrade(row.current_workflow_limit, row.pro_workflow_limit)) {
    warnings.push({ field: "workflowLimit", current: row.current_workflow_limit, upgraded: row.pro_workflow_limit });
  }

  return {
    currentPlanId: row.current_plan_id,
    currentPlanName: row.current_plan_name,
    proPlanName: row.pro_plan_name,
    monthlyAvailable: row.current_plan_id !== "pro",
    yearlyAvailable: row.current_plan_id !== "pro",
    warnings,
  };
}

export async function createCheckout(
  withUser: WithUser,
  userId: string,
  interval: "monthly" | "yearly",
): Promise<{ checkoutUrl: string; subscriptionId: string }> {
  // Non-null: this function is only reached when env.PAYMENTS_ENABLED is
  // true (routes/billing.ts's 503 gate runs first), and env.ts's
  // superRefine() guarantees both plan ids are set whenever that flag is
  // true.
  const razorpayPlanId =
    interval === "monthly" ? env.RAZORPAY_PRO_MONTHLY_PLAN_ID! : env.RAZORPAY_PRO_YEARLY_PLAN_ID!;

  const razorpaySubscription = await createRazorpaySubscription({
    razorpayPlanId,
    notifyCustomer: true,
    // Visible on Razorpay's own dashboard for support/debugging only — the
    // webhook route never trusts notes for anything, it looks up by
    // provider_subscription_id.
    notes: { userId, interval },
  });

  const { rows } = await withUser((db) =>
    db.query<{ id: string }>("select public.create_individual_subscription($1, $2, $3, $4) as id", [
      "pro",
      "razorpay",
      razorpaySubscription.id,
      razorpaySubscription.customerId,
    ]),
  );

  return { checkoutUrl: razorpaySubscription.shortUrl, subscriptionId: rows[0]!.id };
}

export async function getSubscriptionStatus(
  withUser: WithUser,
  subscriptionId: string,
): Promise<{ id: string; status: string } | null> {
  const { rows } = await withUser((db) =>
    db.query<{ id: string; status: string }>("select id, status from public.subscriptions where id = $1", [
      subscriptionId,
    ]),
  );
  return rows[0] ?? null;
}
