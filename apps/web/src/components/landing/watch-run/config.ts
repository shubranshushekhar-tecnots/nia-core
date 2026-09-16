// Pure data + pure derivation functions for the "Watch a pipeline run itself"
// replay demo. No React here — every component reads its slice of state by
// calling these functions with the shared clock value `t` (seconds, one
// 20s loop). Keeping this file framework-free makes the whole timeline easy
// to read/tune in one place and easy to unit-reason about.

export type NodeKind = 'schedule' | 'read' | 'transform' | 'condition' | 'push' | 'end';
export type NodeTone = 'trigger' | 'data' | 'action' | 'condition' | 'muted';
export type NodeStatus = 'ready' | 'running' | 'done' | 'skipped';

export type PipelineNode = {
  id: NodeKind;
  name: string;
  subtitle: string;
  mono: string;
  tone: NodeTone;
  area: string;
  start: number;
  end: number;
};

export type Edge = { from: NodeKind; to: NodeKind; branch?: 'yes' | 'no' };
export type Check = { id: string; label: string; at: number };
export type LogEntry = { t: number; text: string };

export type InspectorContent = {
  kicker: string;
  title: string;
  description: string;
  code?: { lang: string; lines: string[] };
  ops?: string[];
  bars?: number[];
  resultPill?: { label: string; tone: 'success' | 'muted' };
};

export const TONE_VAR: Record<NodeTone, string> = {
  trigger: 'var(--c-trigger)',
  data: 'var(--c-data)',
  action: 'var(--c-action)',
  condition: 'var(--c-condition)',
  muted: 'var(--muted)',
};

export const LOOP_DURATION = 20;
export const CHECKS_PASS = 1.95;
export const CHECKS_DONE = 2.1;
export const RUN_START = 2.4;
export const RUN_END = 12.9;
export const TARGET_ROWS = 1284006;
export const RUN_DURATION_LABEL = '1m 04s';
export const FAKE_RUN_SECONDS = 64;

export const NODES: PipelineNode[] = [
  { id: 'schedule', name: 'Every night · 02:00', subtitle: 'Schedule', mono: '⚡', tone: 'trigger', area: 'schedule', start: 2.4, end: 2.7 },
  { id: 'read', name: 'mysql-sales', subtitle: 'Read', mono: 'DB', tone: 'data', area: 'read', start: 2.7, end: 5.6 },
  { id: 'transform', name: 'Clean + join', subtitle: 'Transform', mono: 'ƒ', tone: 'action', area: 'transform', start: 5.6, end: 8.6 },
  { id: 'condition', name: 'New rows?', subtitle: 'Condition', mono: '◇', tone: 'condition', area: 'condition', start: 8.6, end: 9.3 },
  { id: 'push', name: 'powerbi-sales', subtitle: 'Push', mono: 'BI', tone: 'action', area: 'push', start: 9.3, end: RUN_END },
  { id: 'end', name: 'No changes', subtitle: 'End', mono: '∎', tone: 'muted', area: 'end', start: 9.3, end: 9.3 },
];

export const EDGES: Edge[] = [
  { from: 'schedule', to: 'read' },
  { from: 'read', to: 'transform' },
  { from: 'transform', to: 'condition' },
  { from: 'condition', to: 'push', branch: 'yes' },
  { from: 'condition', to: 'end', branch: 'no' },
];

export const CHECKS: Check[] = [
  { id: 'c1', label: 'mysql-sales reachable', at: 0.3 },
  { id: 'c2', label: 'powerbi-sales reachable', at: 0.75 },
  { id: 'c3', label: 'Credentials valid', at: 1.2 },
  { id: 'c4', label: 'Schema unchanged since last run', at: 1.6 },
  { id: 'c5', label: 'No conflicting runs in progress', at: CHECKS_PASS },
];

export const LOG_ENTRIES: LogEntry[] = [
  { t: 0.05, text: 'Scheduler: checking pipeline preconditions…' },
  { t: 0.3, text: '✓ mysql-sales reachable (42ms)' },
  { t: 0.75, text: '✓ powerbi-sales reachable (81ms)' },
  { t: 1.2, text: '✓ credentials valid' },
  { t: 1.6, text: '✓ schema unchanged since last run' },
  { t: CHECKS_PASS, text: '✓ no conflicting runs — clear to run' },
  { t: RUN_START, text: 'Trigger fired: every night at 02:00' },
  { t: 2.7, text: 'Read: querying mysql-sales.orders…' },
  { t: 5.4, text: 'Read: fetched 1,284,006 rows in 2.7s' },
  { t: 5.6, text: 'Transform: dedupe + join customers…' },
  { t: 8.4, text: 'Transform: emitted 1,284,006 rows' },
  { t: 8.6, text: 'Condition: rows since last run > 0 → true' },
  { t: 9.3, text: 'Push: writing to powerbi-sales.dataset…' },
  { t: 12.7, text: 'Push: 1,284,006 rows written' },
  { t: RUN_END, text: `Run succeeded in ${RUN_DURATION_LABEL}` },
];

export const INSPECTOR: Record<NodeKind, InspectorContent> = {
  schedule: {
    kicker: 'TRIGGER',
    title: 'Schedule',
    description: 'Fires automatically every night — no server to babysit.',
    code: { lang: 'cron', lines: ['0 2 * * *', '# every night at 02:00, server time'] },
    ops: ['Cron: 0 2 * * *', 'Timezone: America/New_York', 'Next run: tomorrow, 02:00'],
  },
  read: {
    kicker: 'DATA',
    title: 'Read — mysql-sales',
    description: 'Pulls every order placed since the last successful run.',
    code: { lang: 'sql', lines: ['select * from orders', 'where updated_at > :last_run_at', 'order by updated_at asc'] },
    ops: ['Connection: mysql-sales', 'Rows read: 1,284,006', 'Duration: 2.7s'],
    bars: [0.2, 0.35, 0.55, 0.7, 0.86, 1],
  },
  transform: {
    kicker: 'ACTION',
    title: 'Transform',
    description: 'Deduplicates orders and joins the customers table.',
    code: { lang: 'js', lines: ['rows', '  .dedupeBy("order_id")', '  .join(customers, "customer_id")', '  .normalize("created_at")'] },
    ops: ['Dedupe by order_id', 'Join customers on customer_id', 'Normalize timestamps'],
  },
  condition: {
    kicker: 'CONDITION',
    title: 'New rows?',
    description: 'Only pushes to the dashboard when there is something new to show.',
    code: { lang: 'js', lines: ['rows_since_last_run > 0'] },
    resultPill: { label: 'true — continue', tone: 'success' },
  },
  push: {
    kicker: 'ACTION',
    title: 'Push — powerbi-sales',
    description: 'Writes the transformed rows to the live dashboard dataset.',
    code: { lang: 'sql', lines: ['insert into dataset.sales_daily', 'select * from :transformed'] },
    ops: ['Connection: powerbi-sales', 'Rows written: 1,284,006', 'Duration: 3.6s'],
    bars: [0.15, 0.3, 0.5, 0.68, 0.84, 1],
  },
  end: {
    kicker: 'BRANCH',
    title: 'End — no changes',
    description: 'Skipped this run — the condition took the "new rows" branch instead.',
    resultPill: { label: 'skipped this run', tone: 'muted' },
  },
};

const SEQUENCE: NodeKind[] = ['schedule', 'read', 'transform', 'condition', 'push'];
const PREEMPT = 0.4;

export function nodeById(id: NodeKind): PipelineNode {
  return NODES.find((n) => n.id === id)!;
}

export function getNodeStatus(id: NodeKind, t: number): NodeStatus {
  const n = nodeById(id);
  if (id === 'end') return t >= n.start ? 'skipped' : 'ready';
  if (t < n.start) return 'ready';
  if (t < n.end) return 'running';
  return 'done';
}

export function getNodeProgress(id: NodeKind, t: number): number {
  const n = nodeById(id);
  if (n.end <= n.start) return t >= n.start ? 1 : 0;
  return Math.max(0, Math.min(1, (t - n.start) / (n.end - n.start)));
}

export function getRowsCount(id: 'read' | 'push', t: number): number {
  const status = getNodeStatus(id, t);
  if (status === 'ready') return 0;
  if (status === 'done') return TARGET_ROWS;
  const p = getNodeProgress(id, t);
  const eased = 1 - Math.pow(1 - p, 3);
  return Math.round(TARGET_ROWS * eased);
}

export function formatRows(n: number): string {
  return n.toLocaleString('en-US');
}

export function getChecksCompleted(t: number): number {
  return CHECKS.filter((c) => t >= c.at).length;
}

export function getVisibleLogCount(t: number): number {
  return LOG_ENTRIES.filter((l) => t >= l.t).length;
}

export function getAutoDockTab(t: number): 'checks' | 'logs' {
  return t < CHECKS_DONE ? 'checks' : 'logs';
}

export function getAutoFollowedNode(t: number): NodeKind {
  let current: NodeKind = SEQUENCE[0]!;
  for (const id of SEQUENCE) {
    const n = nodeById(id);
    const switchAt = Math.max(0, n.start - PREEMPT);
    if (t >= switchAt) current = id;
  }
  return current;
}

export function getElapsedLabel(t: number): string {
  if (t < RUN_START) return '0:00';
  const p = Math.min(1, (t - RUN_START) / (RUN_END - RUN_START));
  const fakeSeconds = Math.round(p * FAKE_RUN_SECONDS);
  const m = Math.floor(fakeSeconds / 60);
  const s = fakeSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type RunButtonState = { label: string; disabled: boolean };

export function getRunButtonState(t: number): RunButtonState {
  return { label: t < RUN_START ? 'Run now' : 'Run again', disabled: t < CHECKS_PASS };
}

export type PillState = 'checking' | 'running' | 'succeeded';

export function getPillState(t: number): PillState {
  if (t < CHECKS_DONE) return 'checking';
  if (t < RUN_END) return 'running';
  return 'succeeded';
}

export function formatLogTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
