// Single source of truth for the ten /docs/agent/* guide pages — used by the
// index page's list and can be reused anywhere else a link to a guide is
// needed (see apps/web/src/components/downloads/DownloadsPage.tsx).
export const AGENT_GUIDES = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    description: 'The whole journey in five steps, from download to your first synced table.',
  },
  {
    slug: 'install-windows',
    title: 'Install on Windows',
    description: 'Run the installer, answer the guided setup questions, verify it checked in.',
  },
  {
    slug: 'install-macos',
    title: 'Install on macOS',
    description: 'Unzip, clear the Gatekeeper warning, run the guided setup, verify it checked in.',
  },
  {
    slug: 'install-linux',
    title: 'Install on Linux',
    description: 'Unpack, run the guided setup, start the agent, verify it checked in.',
  },
  {
    slug: 'connect-database',
    title: 'Connect a database',
    description: 'What details you need, creating a read-only login, adding more databases later.',
  },
  {
    slug: 'local-database-canvas',
    title: 'Use a local database on the Canvas',
    description: 'Add the connection, browse tables, map fields, and publish a job.',
  },
  {
    slug: 'destinations',
    title: 'Destinations',
    description: 'Deliver to a Planometry table or an HTTPS endpoint, and allow it on the agent.',
  },
  {
    slug: 'monitoring',
    title: 'Monitoring and control',
    description: 'The Agents page, job states, pausing, forcing a full reload, error states.',
  },
  {
    slug: 'security',
    title: 'Security',
    description: 'What leaves your network, what never does, the allow-list, revoking access.',
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting and uninstalling',
    description: 'Common problems and how to remove the agent, per operating system.',
  },
] as const;
