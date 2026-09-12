import { z } from "zod";

/**
 * Mirrors the `public.org_role` enum in supabase/migrations/0001_auth_orgs.sql
 * as renamed by 0003_owner_enum_value.sql / 0004_owner_rename.sql. Keep in
 * sync — this is the client-side (UX/routing) mirror of the Postgres RLS
 * policies, which remain the actual source of truth for enforcement.
 *
 * The DB enum also still defines a legacy `super_admin` value (kept for
 * reversibility, see 0004's rollback note) but no row should carry it after
 * that migration runs, so it is deliberately not exposed here.
 */
export const OrgRole = z.enum(["member", "admin", "owner"]);
export type OrgRole = z.infer<typeof OrgRole>;

/**
 * "individual" is not a database role — it never appears in
 * `organization_members.role`. It is the synthetic role for a user with no
 * organization membership at all, operating solely in their own personal
 * workspace (see 0005_individual_workspace.sql / DECISION-D). Callers that
 * know a user has no org pass `"individual"` explicitly; it is never read
 * back from a query.
 */
export type ActorRole = OrgRole | "individual";

export type OrgAction =
  | "org.view"
  | "org.update"
  | "org.transferOwnership"
  | "members.view"
  | "members.invite"
  | "members.remove"
  | "members.changeRole"
  | "billing.view"
  | "billing.mutate"
  | "auditLog.view"
  | "projects.create"
  | "projects.rename"
  | "projects.delete"
  | "workflows.create"
  | "workflows.rename"
  | "workflows.delete"
  | "workflows.updateDefinition"
  | "workflows.run"
  | "connectors.install"
  | "connectors.uninstall"
  | "connections.create"
  | "connections.update"
  | "connections.delete"
  | "connections.test"
  | "grants.create"
  | "grants.revoke";

/**
 * Single declarative capability matrix — the source of truth for "which
 * roles may attempt which action". Postgres RLS remains the actual security
 * boundary (defense-in-depth); this matrix lets server actions/routes fail
 * fast with a typed, stable error code instead of surfacing a raw Postgres
 * RLS error to the caller.
 *
 * DECISION-A: admin billing access is read-only by default (billing.mutate
 * excludes "admin") — the most restrictive default per the product spec,
 * trivial to widen later since it's a single matrix entry.
 *
 * DECISION-B (superseded — see DECISION-C): originally
 * projects/workflows/connectors/connections/grants mutations were
 * "individual, admin, owner" (member read-only everywhere).
 *
 * DECISION-C: the model separates GOVERNANCE from WORK. Every role —
 * individual, member, admin, owner — can do every piece of building work:
 * install/uninstall connectors, create/update/delete/test connections,
 * create/rename/delete projects and workflows, edit workflow definitions,
 * run workflows, and mint/revoke write grants. Admin and owner add only
 * people-level and org-level power (invite/remove members, change roles,
 * billing, audit log) — those stay unchanged below. Each work action is
 * still declared separately (rather than collapsed into one bucket) so a
 * future divergence — e.g. gating workflows.run separately from
 * grants.create — is a one-line matrix edit, not a refactor. Reads (project
 * lists, workflow detail, dashboard stats, the connector catalog) are
 * deliberately NOT in this matrix; they stay RLS-scoped only, consistent
 * with today. connections.test is a mutation (it hits an external system
 * and creates a pool entry) and stays classified with
 * create/update/delete/test, not with reads.
 *
 * IMPORTANT — read before "fixing" this: with member now equal to
 * individual/admin/owner on every action below, `can()`/`assertCan()`
 * currently gate NOTHING beyond org/members/billing/auditLog. Do not treat
 * that as a bug. `assertCan()` still wraps every mutation route — it's the
 * declaration point, so narrowing a single action later is a one-line
 * matrix edit, not a refactor. Because there is no role gate on destructive
 * or credential-minting actions, the audit log is the only record of who
 * installed what, minted which grant, or deleted whose project — treat gaps
 * in audit logging as bugs, not nice-to-haves.
 *
 * Deliberately deferred: whether a member can delete ANOTHER member's
 * project, or only their own. Per the matrix below, members can delete any
 * project in the org. That's an ownership question for RLS, not a role
 * question — don't build ownership checks for it until cross-user project
 * visibility lands.
 */
const CAPABILITY_MATRIX = {
  "org.view": ["individual", "member", "admin", "owner"],
  "org.update": ["admin", "owner"],
  "org.transferOwnership": ["owner"],
  "members.view": ["member", "admin", "owner"],
  "members.invite": ["admin", "owner"],
  "members.remove": ["admin", "owner"],
  "members.changeRole": ["admin", "owner"],
  "billing.view": ["individual", "member", "admin", "owner"],
  "billing.mutate": ["individual", "owner"],
  "auditLog.view": ["admin", "owner"],
  "projects.create": ["individual", "member", "admin", "owner"],
  "projects.rename": ["individual", "member", "admin", "owner"],
  "projects.delete": ["individual", "member", "admin", "owner"],
  "workflows.create": ["individual", "member", "admin", "owner"],
  "workflows.rename": ["individual", "member", "admin", "owner"],
  "workflows.delete": ["individual", "member", "admin", "owner"],
  "workflows.updateDefinition": ["individual", "member", "admin", "owner"],
  "workflows.run": ["individual", "member", "admin", "owner"],
  "connectors.install": ["individual", "member", "admin", "owner"],
  "connectors.uninstall": ["individual", "member", "admin", "owner"],
  "connections.create": ["individual", "member", "admin", "owner"],
  "connections.update": ["individual", "member", "admin", "owner"],
  "connections.delete": ["individual", "member", "admin", "owner"],
  "connections.test": ["individual", "member", "admin", "owner"],
  "grants.create": ["individual", "member", "admin", "owner"],
  "grants.revoke": ["individual", "member", "admin", "owner"],
} as const satisfies Record<OrgAction, readonly ActorRole[]>;

export type PermissionErrorCode = "NOT_AUTHENTICATED" | "INSUFFICIENT_ROLE" | "OWNER_PROTECTED";

export class PermissionError extends Error {
  code: PermissionErrorCode;

  constructor(code: PermissionErrorCode, message: string) {
    super(message);
    this.name = "PermissionError";
    this.code = code;
  }
}

/**
 * Base capability check: does this role's matrix entry allow the action at
 * all? For `members.remove` / `members.changeRole`, this does NOT account
 * for the target member's current role — use canManageMember() for those,
 * which also enforces the owner invariants below.
 */
export function can(role: ActorRole | null | undefined, action: OrgAction): boolean {
  if (!role) return false;
  return (CAPABILITY_MATRIX[action] as readonly ActorRole[]).includes(role);
}

/** Throwing variant of can() for server actions/routes. */
export function assertCan(role: ActorRole | null | undefined, action: OrgAction): void {
  if (!role) {
    throw new PermissionError("NOT_AUTHENTICATED", "You must be signed in.");
  }
  if (!can(role, action)) {
    throw new PermissionError("INSUFFICIENT_ROLE", `Your role ("${role}") cannot perform "${action}".`);
  }
}

/**
 * Owner-invariant guard for mutating a specific member row. Mirrors the
 * organization_members RLS policies in 0001_auth_orgs.sql (rewritten by
 * 0004_owner_rename.sql):
 *   - Nobody but another owner may change or remove an existing owner.
 *   - Nobody but an existing owner may promote a member/admin to owner.
 * An org must always keep at least one owner — that invariant is enforced
 * only by the `protect_last_super_admin` trigger in the database, since it
 * requires a live count of an org's owners that this pure function has no
 * access to.
 */
export function canManageMember(
  actorRole: ActorRole | null | undefined,
  targetCurrentRole: OrgRole,
  newRole?: OrgRole,
): boolean {
  const action: OrgAction = newRole === undefined ? "members.remove" : "members.changeRole";
  if (!can(actorRole, action)) return false;
  if (targetCurrentRole === "owner" && actorRole !== "owner") return false;
  if (newRole === "owner" && actorRole !== "owner") return false;
  return true;
}

/** Throwing variant of canManageMember() for server actions/routes. */
export function assertCanManageMember(
  actorRole: ActorRole | null | undefined,
  targetCurrentRole: OrgRole,
  newRole?: OrgRole,
): void {
  if (!actorRole) {
    throw new PermissionError("NOT_AUTHENTICATED", "You must be signed in.");
  }
  if (!canManageMember(actorRole, targetCurrentRole, newRole)) {
    throw new PermissionError(
      "OWNER_PROTECTED",
      "Only an owner can change or remove another owner, or promote someone to owner.",
    );
  }
}
