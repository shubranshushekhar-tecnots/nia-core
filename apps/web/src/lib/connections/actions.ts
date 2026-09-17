'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getConnectorManifest } from '@nia/schemas';
import { apiFetchServer, ApiError } from '@/lib/api/server';
import type { ActionState } from '@/lib/auth/actions';

// First use of the "Server Action calls Express" pattern in this codebase
// (lib/dashboard/actions.ts's Server Actions all hit Supabase directly).
// Correct here because Step 4's Vault-write/dispatch/audit-chokepoint logic
// only exists behind Express — there is no direct-table equivalent to fall
// back to for connections.

function apiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.message || fallback;
  return fallback;
}

export async function installConnectorAction(
  connectorId: string,
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    await apiFetchServer('/connectors/installs', {
      method: 'POST',
      body: JSON.stringify({ connectorId }),
    });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't install the connector. Try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}

const displayNameSchema = z.object({
  displayName: z.string().trim().min(1, 'Name is required').max(120, 'Keep it under 120 characters'),
});

/**
 * Builds the `fields` payload from raw formData using the connector's own
 * configSchema (labels/types, imported directly from @nia/schemas — see
 * Step 5 plan decision #2) so number/boolean fields aren't sent to Express
 * as bare strings.
 */
export async function createConnectionAction(
  connectorId: string,
  _prevState: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsedName = displayNameSchema.safeParse({ displayName: formData.get('displayName') });
  if (!parsedName.success) {
    return { fieldErrors: parsedName.error.flatten().fieldErrors };
  }

  const manifest = getConnectorManifest(connectorId);
  if (!manifest) return { error: `No manifest for connector "${connectorId}".` };

  const fields: Record<string, unknown> = {};
  for (const field of manifest.configSchema) {
    const raw = formData.get(field.key);
    if (raw === null || raw === '') continue;
    if (field.type === 'number') fields[field.key] = Number(raw);
    else if (field.type === 'boolean') fields[field.key] = raw === 'on' || raw === 'true';
    else fields[field.key] = String(raw);
  }

  try {
    await apiFetchServer('/connections', {
      method: 'POST',
      body: JSON.stringify({ connectorId, displayName: parsedName.data.displayName, fields }),
    });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't create the connection. Check the details and try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}

export async function uninstallConnectorAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const installId = String(formData.get('id'));
  try {
    await apiFetchServer(`/connectors/installs/${installId}`, { method: 'DELETE' });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't uninstall the connector. Try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}

export async function testConnectionAction(
  connectionId: string,
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    await apiFetchServer(`/connections/${connectionId}/test`, { method: 'POST' });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't run the test. Try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}

/**
 * Phase 5 Session 5, Block 2 — "Refresh schema" affordance. Busts both the
 * Express process's cached introspection result AND the worker's separate
 * cache (see apps/api/src/services/connections.ts's refreshConnectionSchema
 * header comment) so a since-drifted field is picked up by the NEXT "Run
 * checks" and the next time a destination drawer's field pickers load —
 * without this, both would keep reporting the pre-drift schema until each
 * cache's 5-minute TTL happened to expire on its own.
 */
export async function refreshConnectionSchemaAction(
  connectionId: string,
  _prevState: ActionState,
  _formData: FormData,
): Promise<ActionState> {
  try {
    await apiFetchServer(`/connections/${connectionId}/schema/refresh`, { method: 'POST' });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't refresh the schema. Try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}

export async function deleteConnectionAction(_prevState: ActionState, formData: FormData): Promise<ActionState> {
  const connectionId = String(formData.get('id'));
  try {
    await apiFetchServer(`/connections/${connectionId}`, { method: 'DELETE' });
  } catch (err) {
    return { error: apiErrorMessage(err, "Couldn't delete the connection. Try again.") };
  }
  revalidatePath('/app/connections');
  return { success: true };
}
