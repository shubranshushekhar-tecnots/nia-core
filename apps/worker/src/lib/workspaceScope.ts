/**
 * Mirrors apps/api/src/lib/workspaceScope.ts's WorkspaceScope exactly — the
 * org_id/owner_id xor enforced by the connections table's RLS policies
 * (0007_connectors.sql). The worker needs its own copy of this type (not
 * imported from apps/api) because it re-derives this check itself, in
 * application code, against a service_role client that never sees RLS at
 * all — see supabaseClient.ts's header comment for why that check is
 * mandatory here, not optional.
 */
export type WorkspaceScope = { orgId: string } | { ownerId: string };
