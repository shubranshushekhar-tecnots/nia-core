import type { WorkspaceScope } from "@nia/db";
import type { UserContext } from "./actorTypes.js";

/**
 * Re-exported from @nia/db (docs/plans/data-access.md's Step 3) — the one
 * canonical WorkspaceScope definition, no longer redeclared here. Matches
 * the org_id/owner_id xor enforced by the projects/workflows/workflow_runs
 * RLS policies (see 0005_individual_workspace.sql).
 */
export type { WorkspaceScope };

/** Every dashboard/projects/workflows route derives scope from req.actor this way. */
export function scopeFromActor(actor: UserContext): WorkspaceScope {
  return actor.org ? { orgId: actor.org.id } : { ownerId: actor.userId };
}
