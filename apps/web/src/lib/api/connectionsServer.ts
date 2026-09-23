import { apiFetchServer } from './server';
import type { Connection, ConnectorCatalogEntry, ConnectorInstall } from '@/lib/connections/types';

export function getConnectorCatalog(): Promise<ConnectorCatalogEntry[]> {
  return apiFetchServer<ConnectorCatalogEntry[]>('/connectors');
}

export function getConnectorInstalls(): Promise<ConnectorInstall[]> {
  return apiFetchServer<ConnectorInstall[]>('/connectors/installs');
}

export function getConnections(): Promise<Connection[]> {
  return apiFetchServer<Connection[]>('/connections');
}
