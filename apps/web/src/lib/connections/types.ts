// Mirrors apps/api/src/services/{connectors,connections}.ts's exported
// response shapes 1:1 — this is the BFF read contract, not a re-derivation
// of the DB schema (which stays behind Express/RLS).

import type { Operation, Capability } from '@nia/schemas';

export type ConnectorCatalogEntry = {
  id: string;
  name: string;
  category: string;
  version: string;
  operations: Operation[];
  capabilities: Capability[];
};

export type ConnectorInstall = {
  id: string;
  connectorId: string;
  installedByUserId: string;
  installedAt: string;
};

export type Connection = {
  id: string;
  connectorId: string;
  handle: string;
  displayName: string;
  ownerUserId: string;
  config: Record<string, unknown>;
  credVersion: number;
  lastTestStatus: 'ok' | 'error' | null;
  lastTestLatencyMs: number | null;
  lastTestAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Item 6.2 (fix-chain plan): same-named connections are otherwise
 * indistinguishable in any picker/label. The plan's own suggestion was
 * `(${user}@${host})`, but `user` is a `secret: true` configSchema field
 * (packages/schemas/src/connectors/*.ts) — never split into `config`
 * server-side (apps/api/src/services/connections.ts's splitFields), only
 * into the vault secret — so it's never present here. `host` + `database`
 * (both non-secret) are the next most useful disambiguators available on
 * the client.
 */
export function connectionSecondaryLabel(connection: Pick<Connection, 'config'>): string | undefined {
  const host = typeof connection.config.host === 'string' ? connection.config.host : undefined;
  const database = typeof connection.config.database === 'string' ? connection.config.database : undefined;
  if (host && database) return `${host}/${database}`;
  return host ?? database;
}
