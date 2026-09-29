# Subscription model (planned — start after Console is complete)

## Plans (starting prices, to validate against measured costs; GST extra)
| | Free | Pro (individual) | Team (Org) | Enterprise |
|---|---|---|---|---|
| Price | ₹0 | ₹1,499/mo (₹1,249/mo yearly) | ₹1,999/seat/mo, min 3 seats | Custom |
| Projects | 1 | 5 | Unlimited | Unlimited |
| Workflows | 2 | Unlimited | Unlimited | Unlimited |
| Rows moved/mo | 100k | 2M | 10M pooled, then ₹400 per extra 1M | Custom |
| Copilot actions/mo | 50 | 500 | 2,000 pooled | Custom |
| Fastest schedule | Daily | Hourly | 15 min | Custom |
| Run history | 7 days | 30 days | 90 days | 1 year |
| Extras | — | — | Roles, invite links, audit log | SSO, fixed outbound IP, SLA |
Before finalizing: measure infra cost per 1M rows and LLM cost per Copilot action; price ≥ 4–5× cost.

## Roles
- Member: full CRUD, no approval needed; can't invite, promote, or remove anyone. Granting write access to a customer database is Admin/Owner only.
- Admin: member rights + invite links, promote member→admin, remove members from org/projects.
- Owner: admin rights + make owners/admins, remove anyone incl. admins, invite any role. Multiple owners allowed; the last owner can never be removed/demoted. One owner is the billing owner (transferable).
- Viewer (proposed): read-only.
- Invite links: role-bound, expire (7 days), revocable, optional use limit and email-domain lock.
- Project access: members see only projects they're added to; admins/owners see all (proposed).

## Super admin (align with Console principles)
- Console tools only — never decrypted credentials or customer data rows; no impersonation.
- Unlimited usage via an internal org on an unlimited plan, not special staff rules.
- Can remove anyone from any org/project with a required reason, audit entry, and notice to the org owner; never the last owner.
- Announcements: in-app first (all / org / project), with preview and log; email later once an email service exists.

## Upgrades / downgrades / payments
- Free→Pro keeps everything. Free/Pro→Org moves the user's projects into the new org; user becomes owner.
- Over limit or downgrade: nothing deleted; existing items stay; creating new ones is blocked with an upgrade message.
- Failed payment: 7-day grace, then pause schedules; never delete data without long notice.
- Existing users are grandfathered (personal workspaces currently default to 25 workflows).
- Payments: Razorpay (India: INR, UPI, subscriptions) + Stripe (international). GST 18% with GSTIN for businesses — confirm with CA.

## Build order
1. Plans + limits (plans table, project limits, enforcement, upgrade prompts; staff set plans via Console).
2. Roles + access (Viewer, admin-only write grants, last-owner protection, invite links, project membership).
3. Usage metering (rows per run, Copilot actions, usage display, 80%/100% warnings).
4. Payments (Razorpay + Stripe, checkout, invoices, GST, dunning).
5. Console additions (announcements, staff member removal with reason).

## Open decisions
1. Meter rows moved (recommended) or runs?
2. Team pricing per seat (recommended) or flat per org?
3. Members see all projects, or only ones they're added to?
4. Add the Viewer role?
