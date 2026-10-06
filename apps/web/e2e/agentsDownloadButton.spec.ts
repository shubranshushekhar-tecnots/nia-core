import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, expect } from '@playwright/test';
import { Pool } from 'pg';
import { personas } from './fixtures/personas';

/**
 * Same env-loading need as agents.spec.ts — this process is plain node,
 * never routed through Next's own env loading.
 */
function loadWebEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || !/^[A-Z0-9_]+$/.test(trimmed.slice(0, eq))) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadWebEnv();

test.use({ storageState: personas.canvasA.storageStatePath });

const AGENT_NAME = `e2e-download-btn-${Date.now()}`;

/**
 * Lighter-weight sibling of agents.spec.ts: this one only needs an existing
 * row in the list, not a real paired CLI, so it inserts a platform_agents
 * row directly (bypassing consume_agent_pairing_code — fine here since we
 * never assert pairing/online behavior, only that the page header's
 * "Download agent" button still renders once the list is non-empty).
 */
test('Agents page shows the Download agent button when agents already exist', async ({ page }) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let agentId: string | null = null;

  try {
    const { rows } = await pool.query<{ org_id: string; user_id: string }>(
      `select m.org_id, m.user_id
       from public.organization_members m
       join public."user" u on u.id = m.user_id
       where u.email = $1
       limit 1`,
      [personas.canvasA.email],
    );
    const member = rows[0];
    if (!member) throw new Error(`no organization_members row found for ${personas.canvasA.email}`);

    const insertResult = await pool.query<{ id: string }>(
      `insert into public.platform_agents
         (org_id, created_by_user_id, display_name, agent_key_hash, status)
       values ($1, $2, $3, $4, 'active')
       returning id`,
      [member.org_id, member.user_id, AGENT_NAME, crypto.randomBytes(32).toString('hex')],
    );
    const inserted = insertResult.rows[0];
    if (!inserted) throw new Error('insert into platform_agents returned no row');
    agentId = inserted.id;

    await page.goto('/app/agents');
    await expect(page.getByText(AGENT_NAME)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Download agent' })).toBeVisible();
  } finally {
    if (agentId) {
      await pool.query('delete from public.platform_agents where id = $1', [agentId]);
    }
    await pool.end();
  }
});
