import type { UserContext } from "./actorTypes.js";

/**
 * Mirrors apps/web/src/lib/dashboard/queries.ts's WorkspaceScope exactly —
 * the org_id/owner_id xor enforced by the projects/workflows/workflow_runs
 * RLS policies (see 0005_individual_workspace.sql).
 */
export type WorkspaceScope = { orgId: string } | { ownerId: string };

/** Every dashboard/projects/workflows route derives scope from req.actor this way. */
export function scopeFromActor(actor: UserContext): WorkspaceScope {
  return actor.org ? { orgId: actor.org.id } : { ownerId: actor.userId };
}
