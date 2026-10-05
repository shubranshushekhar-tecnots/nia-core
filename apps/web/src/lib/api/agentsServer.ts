import { apiFetchServer } from './server';
import { mapAgents } from '@/lib/agents/mapAgent';
import type { PlatformAgent } from '@/lib/agents/types';

/** Server Component GET for the Agents list page — docs/plans/agent-canvas-integration.md Slice L3. */
export async function getAgents(): Promise<PlatformAgent[]> {
  const raw = await apiFetchServer<unknown[]>('/agents');
  return mapAgents(raw);
}
