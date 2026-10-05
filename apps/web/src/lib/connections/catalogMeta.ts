import type { ConnectorCategory } from '@/components/app/styles';

/**
 * Static catalog metadata for the Connections page's "Available" grid —
 * the 12-connector set from the design (designs/Nia Core — Workflow
 * Canvas.html, "Connections — with connections" / "no connections yet"
 * artboards). The `/connectors` API only returns manifest-backed entries
 * (id/name/category/version/operations/capabilities) for the 4 real
 * connectors (mysql, mongodb, supabase, postgres — packages/schemas/src/
 * connectors/registry.ts); everything here is marketing copy/category/icon
 * metadata the API doesn't and shouldn't own, same precedent as
 * ConnectionsClient.tsx's previous REAL_CONNECTOR_META/AVAILABLE constants.
 *
 * Condition #2 (fix-chain approval): only the 4 ids with `comingSoon: false`
 * ever render a working "Connect"/"Install" affordance — every other entry
 * is `comingSoon: true` and renders the "SOON" / "On the roadmap" treatment
 * with no clickable-looking button, regardless of whether a manifest for it
 * ever ships later.
 *
 * `iconSlug` names a `simple-icons` named export (e.g. "mysql" ->
 * `siMysql`, see ConnectorLogo.tsx) for the 8 of these 12 vendors simple-
 * icons actually ships a mark for; `undefined` means ConnectorLogo falls
 * back to a plain initials tile — confirmed once via `node -e` against the
 * installed simple-icons@16.31.0 package, not guessed:
 *   has:    mysql, mongodb, supabase, postgresql, snowflake,
 *           googlebigquery, metabase, qdrant
 *   lacks:  amazonredshift, lookerstudio, pinecone, amazons3
 */
export type ConnectorCatalogMeta = {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  tags: string[];
  iconSlug?: string;
  comingSoon: boolean;
  // Card redesign (Step 3/4): "Works as" filter + the card's facts row.
  // For the 4 real connectors these match packages/schemas/src/connectors/
  // {mysql,mongodb,supabase,postgres}.ts's manifest `operations` 1:1 (all
  // four ship `["read","insert"]`, i.e. usable as both a workflow source
  // and destination) — ConnectorCard prefers the live `/connectors` API
  // entry's `operations` when one is passed in and only falls back to
  // these static values when it isn't. For the 8 comingSoon entries (no
  // manifest exists yet) these are read directly off each entry's own
  // description above, not invented: e.g. metabase/lookerstudio/qdrant/
  // snowflake/bigquery/redshift/s3's copy only ever says "pull"/"query"/
  // "search"/"reach" (source-only); pinecone's says "read and write"
  // (both).
  isSource: boolean;
  isDestination: boolean;
  // Canonical vendor docs homepage for the card's round "Docs" button —
  // only set for the 4 real connectors (well-known, stable URLs); left
  // undefined for comingSoon entries, whose Docs button stays disabled.
  docsUrl?: string;
  // Real auth method shown in the card's facts row and (for the 4 real
  // connectors) the Installed section. For the 4 real connectors this is
  // read directly off each one's actual config field list in
  // packages/schemas/src/connectors/{mysql,mongodb,supabase,postgres}.ts
  // (mysql/mongodb: password only; supabase/postgres: password + an `ssl`
  // field). The 8 comingSoon entries reuse the general auth family already
  // encoded in `tags` ('oauth' | 'credentials') above — never invented,
  // just promoted to an explicit field instead of re-derived from tags at
  // render time.
  authMethod: string;
};

// Order fixes each card's design "index" number (01–12) and the grid's
// default rendering order — matches the design's Databases → Warehouses →
// BI → AI vector → Files grouping.
export const CATALOG_ORDER: readonly string[] = [
  'mysql',
  'mongodb',
  'supabase',
  'postgres',
  'sqlserver-agent',
  'planometry-table',
  'https-endpoint',
  'snowflake',
  'bigquery',
  'redshift',
  'metabase',
  'lookerstudio',
  'qdrant',
  'pinecone',
  's3',
];

export const CONNECTOR_CATALOG_META: Record<string, ConnectorCatalogMeta> = {
  mysql: {
    id: 'mysql',
    name: 'MySQL',
    category: 'databases',
    description: 'Query tables directly with read-only credentials.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'mysql',
    comingSoon: false,
    isSource: true,
    isDestination: true,
    docsUrl: 'https://dev.mysql.com/doc/',
    authMethod: 'Password',
  },
  mongodb: {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'databases',
    description: 'Run aggregation pipelines against collections with read-only credentials.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'mongodb',
    comingSoon: false,
    isSource: true,
    isDestination: true,
    docsUrl: 'https://www.mongodb.com/docs/',
    authMethod: 'Password',
  },
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    category: 'databases',
    description: 'Query a hosted Supabase Postgres project directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'supabase',
    comingSoon: false,
    isSource: true,
    isDestination: true,
    docsUrl: 'https://supabase.com/docs',
    authMethod: 'Password + TLS',
  },
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'databases',
    description: 'Query a self-hosted or managed Postgres database directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'postgresql',
    comingSoon: false,
    isSource: true,
    isDestination: true,
    docsUrl: 'https://www.postgresql.org/docs/',
    authMethod: 'Password + TLS',
  },
  'sqlserver-agent': {
    id: 'sqlserver-agent',
    name: 'Local database (via agent)',
    category: 'databases',
    description: 'Query a database only reachable from your machine, through a paired desktop agent.',
    tags: ['credentials', 'queryable', 'etl'],
    comingSoon: false,
    isSource: true,
    isDestination: false,
    authMethod: 'Agent-resolved (no credentials stored)',
  },
  'planometry-table': {
    id: 'planometry-table',
    name: 'Planometry table',
    category: 'bi',
    description: 'Push rows into a Planometry table over its push API.',
    tags: ['credentials', 'actions'],
    comingSoon: false,
    isSource: false,
    isDestination: true,
    authMethod: 'Credentials',
  },
  'https-endpoint': {
    id: 'https-endpoint',
    name: 'HTTPS endpoint',
    category: 'bi',
    description: 'Push rows to any HTTPS address, with your choice of sign-in method.',
    tags: ['credentials', 'actions'],
    comingSoon: false,
    isSource: false,
    isDestination: true,
    authMethod: 'Credentials',
  },
  snowflake: {
    id: 'snowflake',
    name: 'Snowflake',
    category: 'warehouses',
    description: 'Run warehouse-scale questions without moving the data out.',
    tags: ['credentials', 'warehouse', 'queryable'],
    iconSlug: 'snowflake',
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'Credentials',
  },
  bigquery: {
    id: 'bigquery',
    name: 'BigQuery',
    category: 'warehouses',
    description: 'Query datasets in place and cite the tables behind each answer.',
    tags: ['oauth', 'warehouse', 'queryable'],
    iconSlug: 'googlebigquery',
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'OAuth',
  },
  redshift: {
    id: 'redshift',
    name: 'Redshift',
    category: 'warehouses',
    description: 'Reach a Redshift cluster through an IAM role.',
    tags: ['oauth', 'warehouse', 'queryable'],
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'OAuth',
  },
  metabase: {
    id: 'metabase',
    name: 'Metabase',
    category: 'bi',
    description: 'Pull questions and dashboards into a workflow as a source.',
    tags: ['credentials', 'queryable'],
    iconSlug: 'metabase',
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'Credentials',
  },
  lookerstudio: {
    id: 'lookerstudio',
    name: 'Looker Studio',
    category: 'bi',
    description: 'Pull explores and reports into a workflow as a source.',
    tags: ['oauth', 'queryable'],
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'OAuth',
  },
  qdrant: {
    id: 'qdrant',
    name: 'Qdrant',
    category: 'ai-vector',
    description: 'Search embeddings stored in a Qdrant collection.',
    tags: ['credentials', 'ai vector', 'queryable'],
    iconSlug: 'qdrant',
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'Credentials',
  },
  pinecone: {
    id: 'pinecone',
    name: 'Pinecone',
    category: 'ai-vector',
    description: 'Read and write vectors from a managed index.',
    tags: ['credentials', 'ai vector', 'actions'],
    comingSoon: true,
    isSource: true,
    isDestination: true,
    authMethod: 'Credentials',
  },
  s3: {
    id: 's3',
    name: 'Amazon S3',
    category: 'files',
    description: 'Treat objects in a bucket as files your workflows can query.',
    tags: ['oauth', 'files'],
    comingSoon: true,
    isSource: true,
    isDestination: false,
    authMethod: 'OAuth',
  },
};

export function catalogIndexLabel(id: string): string {
  const i = CATALOG_ORDER.indexOf(id);
  return i === -1 ? '' : String(i + 1).padStart(2, '0');
}

// "Works as" filter + card facts row: prefers the live `/connectors` API
// entry's real `capabilities` (etl_source/etl_sink) when one is passed in
// (the 4 real connectors — see registry.ts) and only falls back to this
// meta's static isSource/isDestination for the 8 comingSoon ids, which
// have no manifest/API entry to read from.
export function resolveWorksAs(
  meta: ConnectorCatalogMeta,
  catalogEntry?: { capabilities: readonly string[] },
): { isSource: boolean; isDestination: boolean } {
  if (catalogEntry) {
    return {
      isSource: catalogEntry.capabilities.includes('etl_source'),
      isDestination: catalogEntry.capabilities.includes('etl_sink'),
    };
  }
  return { isSource: meta.isSource, isDestination: meta.isDestination };
}
