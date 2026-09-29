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
};

// Order fixes each card's design "index" number (01–12) and the grid's
// default rendering order — matches the design's Databases → Warehouses →
// BI → AI vector → Files grouping.
export const CATALOG_ORDER: readonly string[] = [
  'mysql',
  'mongodb',
  'supabase',
  'postgres',
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
  },
  mongodb: {
    id: 'mongodb',
    name: 'MongoDB',
    category: 'databases',
    description: 'Run aggregation pipelines against collections with read-only credentials.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'mongodb',
    comingSoon: false,
  },
  supabase: {
    id: 'supabase',
    name: 'Supabase',
    category: 'databases',
    description: 'Query a hosted Supabase Postgres project directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'supabase',
    comingSoon: false,
  },
  postgres: {
    id: 'postgres',
    name: 'PostgreSQL',
    category: 'databases',
    description: 'Query a self-hosted or managed Postgres database directly over TLS.',
    tags: ['credentials', 'queryable', 'etl'],
    iconSlug: 'postgresql',
    comingSoon: false,
  },
  snowflake: {
    id: 'snowflake',
    name: 'Snowflake',
    category: 'warehouses',
    description: 'Run warehouse-scale questions without moving the data out.',
    tags: ['credentials', 'warehouse', 'queryable'],
    iconSlug: 'snowflake',
    comingSoon: true,
  },
  bigquery: {
    id: 'bigquery',
    name: 'BigQuery',
    category: 'warehouses',
    description: 'Query datasets in place and cite the tables behind each answer.',
    tags: ['oauth', 'warehouse', 'queryable'],
    iconSlug: 'googlebigquery',
    comingSoon: true,
  },
  redshift: {
    id: 'redshift',
    name: 'Redshift',
    category: 'warehouses',
    description: 'Reach a Redshift cluster through an IAM role.',
    tags: ['oauth', 'warehouse', 'queryable'],
    comingSoon: true,
  },
  metabase: {
    id: 'metabase',
    name: 'Metabase',
    category: 'bi',
    description: 'Pull questions and dashboards into a workflow as a source.',
    tags: ['credentials', 'queryable'],
    iconSlug: 'metabase',
    comingSoon: true,
  },
  lookerstudio: {
    id: 'lookerstudio',
    name: 'Looker Studio',
    category: 'bi',
    description: 'Pull explores and reports into a workflow as a source.',
    tags: ['oauth', 'queryable'],
    comingSoon: true,
  },
  qdrant: {
    id: 'qdrant',
    name: 'Qdrant',
    category: 'ai-vector',
    description: 'Search embeddings stored in a Qdrant collection.',
    tags: ['credentials', 'ai vector', 'queryable'],
    iconSlug: 'qdrant',
    comingSoon: true,
  },
  pinecone: {
    id: 'pinecone',
    name: 'Pinecone',
    category: 'ai-vector',
    description: 'Read and write vectors from a managed index.',
    tags: ['credentials', 'ai vector', 'actions'],
    comingSoon: true,
  },
  s3: {
    id: 's3',
    name: 'Amazon S3',
    category: 'files',
    description: 'Treat objects in a bucket as files your workflows can query.',
    tags: ['oauth', 'files'],
    comingSoon: true,
  },
};

export function catalogIndexLabel(id: string): string {
  const i = CATALOG_ORDER.indexOf(id);
  return i === -1 ? '' : String(i + 1).padStart(2, '0');
}
