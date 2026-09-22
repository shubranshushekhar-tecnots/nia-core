// Connector directory dataset — ported verbatim from designs/Connectors —
// full page-html/Connectors.dc.html's component logic script (the `all`
// array and `names` filter list). Copy/grouping/mode values are exact.
export type ConnectorGroup =
  | 'Databases'
  | 'Warehouses'
  | 'Files'
  | 'BI and sheets'
  | 'SaaS';

export type ConnectorMode = 'Read · Write' | 'Read only';

export type ConnectorEntry = {
  name: string;
  group: ConnectorGroup;
  mode: ConnectorMode;
};

export const CONNECTORS: ConnectorEntry[] = [
  { name: 'PostgreSQL', group: 'Databases', mode: 'Read · Write' },
  { name: 'MySQL', group: 'Databases', mode: 'Read · Write' },
  { name: 'SQL Server', group: 'Databases', mode: 'Read · Write' },
  { name: 'MongoDB', group: 'Databases', mode: 'Read · Write' },
  { name: 'Oracle', group: 'Databases', mode: 'Read only' },
  { name: 'Redis', group: 'Databases', mode: 'Read · Write' },
  { name: 'Snowflake', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'BigQuery', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'Redshift', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'Databricks', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'ClickHouse', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'DuckDB', group: 'Warehouses', mode: 'Read · Write' },
  { name: 'Amazon S3', group: 'Files', mode: 'Read · Write' },
  { name: 'Cloud Storage', group: 'Files', mode: 'Read · Write' },
  { name: 'Azure Blob', group: 'Files', mode: 'Read · Write' },
  { name: 'SFTP', group: 'Files', mode: 'Read · Write' },
  { name: 'CSV upload', group: 'Files', mode: 'Read only' },
  { name: 'Parquet', group: 'Files', mode: 'Read · Write' },
  { name: 'Looker', group: 'BI and sheets', mode: 'Read only' },
  { name: 'Tableau', group: 'BI and sheets', mode: 'Read only' },
  { name: 'Metabase', group: 'BI and sheets', mode: 'Read only' },
  { name: 'Google Sheets', group: 'BI and sheets', mode: 'Read · Write' },
  { name: 'Excel Online', group: 'BI and sheets', mode: 'Read · Write' },
  { name: 'Power BI', group: 'BI and sheets', mode: 'Read only' },
  { name: 'Salesforce', group: 'SaaS', mode: 'Read · Write' },
  { name: 'HubSpot', group: 'SaaS', mode: 'Read · Write' },
  { name: 'Stripe', group: 'SaaS', mode: 'Read only' },
  { name: 'Shopify', group: 'SaaS', mode: 'Read only' },
  { name: 'Zendesk', group: 'SaaS', mode: 'Read only' },
  { name: 'Notion', group: 'SaaS', mode: 'Read · Write' },
];

export const CONNECTOR_FILTERS: readonly ('All' | ConnectorGroup)[] = [
  'All',
  'Databases',
  'Warehouses',
  'Files',
  'BI and sheets',
  'SaaS',
];
