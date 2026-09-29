import type { WriteGrant } from '@/lib/api/connectionsClient';

export type GrantRowStatus = 'confirmed' | 'pending' | 'revoked';

export type GrantRow = {
  id: string;
  namespaces: string[];
  writeRoleName: string | null;
  status: GrantRowStatus;
};

/**
 * Learning mode, Step 7 — pure derivation of each grant's display status
 * from the three WriteGrant timestamp/role fields, mirroring the same
 * revokedAt/confirmedAt precedence NodeDrawer.tsx's GrantAccessPanel/
 * RevokeAccessPanel already use to pick pendingGrant vs activeGrant
 * (revoked wins, then confirmed, else pending). Kept as its own pure
 * function so /app/connections's read-only status summary is unit
 * testable without any of NodeDrawer's UI/mutation code or jsdom.
 */
function grantStatus(grant: WriteGrant): GrantRowStatus {
  if (grant.revokedAt) return 'revoked';
  if (grant.confirmedAt) return 'confirmed';
  return 'pending';
}

function grantNamespaces(grant: WriteGrant): string[] {
  const schemas = (grant.scope as { schemas?: unknown }).schemas;
  return Array.isArray(schemas) ? schemas.filter((s): s is string => typeof s === 'string') : [];
}

export function summarizeGrants(grants: WriteGrant[]): { confirmedCount: number; rows: GrantRow[] } {
  const rows = grants.map((g) => ({
    id: g.id,
    namespaces: grantNamespaces(g),
    writeRoleName: g.writeRoleName,
    status: grantStatus(g),
  }));
  const confirmedCount = rows.filter((r) => r.status === 'confirmed').length;
  return { confirmedCount, rows };
}
