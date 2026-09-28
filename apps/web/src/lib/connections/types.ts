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

/**
 * Workflow canvas redesign: no `region` field is stored on a Connection
 * anywhere (see this file's own shape above) — the node card/rail's
 * "Postgres · ap-south-1" sub-line derives it from `config.host` with a
 * best-effort regex instead of inventing data. Matches the AWS-style
 * region segment (`us-east-1`, `ap-south-1`, ...) that shows up verbatim in
 * RDS hostnames and Supabase's pooler hostnames (`aws-0-ap-south-1.pooler.
 * supabase.com`) alike. Hosts that don't contain this pattern (plain IPs,
 * PlanetScale's `aws.connect.psdb.cloud`, localhost, ...) return undefined
 * — callers must render nothing rather than guess.
 */
const REGION_PATTERN = /\b([a-z]{2}-[a-z]+-\d)\b/;

export function connectionRegion(connection: Pick<Connection, 'config'>): string | undefined {
  const host = typeof connection.config.host === 'string' ? connection.config.host : undefined;
  if (!host) return undefined;
  return host.match(REGION_PATTERN)?.[1];
}
