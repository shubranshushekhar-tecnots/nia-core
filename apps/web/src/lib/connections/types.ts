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
