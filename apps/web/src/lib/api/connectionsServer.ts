import { apiFetchServer } from './server';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';
import type { WriteGrant } from './connectionsClient';

export function getConnectorCatalog(): Promise<ConnectorCatalogEntry[]> {
  return apiFetchServer<ConnectorCatalogEntry[]>('/connectors');
}

export function getConnectorInstalls(): Promise<ConnectorInstall[]> {
  return apiFetchServer<ConnectorInstall[]>('/connectors/installs');
}

export function getConnections(): Promise<Connection[]> {
  return apiFetchServer<Connection[]>('/connections');
}

/**
 * Learning mode, Step 7 — server-side counterpart to connectionsClient.ts's
 * getWriteGrants (same endpoint, same response shape), used by the
 * connections page to render each connection's write-access status without
 * a client-side fetch or a new QueryClientProvider (this route has none).
 */
export function getConnectionGrants(connectionId: string): Promise<WriteGrant[]> {
  return apiFetchServer<WriteGrant[]>(`/connections/${connectionId}/grants`);
}
