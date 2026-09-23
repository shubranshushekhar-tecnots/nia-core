'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { friendlyConnectionError, getConnectorManifest } from '@nia/schemas';
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

/**
 * Item 5 (fix-chain plan): only `testConnectionAction`/`refreshConnectionSchemaAction`
 * surface raw connector/driver text (the `/test` and `/schema/refresh` Express
 * routes forward the connector service's own error message verbatim) — the
 * other actions in this file (install/create/uninstall/delete) surface
 * structured `AppError`-style messages (e.g. "No manifest for connector...",
 * usage-warning text) that aren't raw driver errors and shouldn't be run
 * through `friendlyConnectionError`'s pattern-matching (its generic
 * "Connection failed." fallback would mislabel them). So this helper is used
 * only by those two actions, not folded into `apiErrorMessage` itself.
 */
function friendlyApiErrorMessage(err: unknown, fallback: string): ActionState {
  if (!(err instanceof ApiError) || !err.message) return { error: fallback };
  const { summary, details } = friendlyConnectionError(err.message);
  return { error: summary, errorDetails: details };
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
    // Trim text fields (host/database/user) but never `password` — accidental
    // leading/trailing whitespace here doesn't just look wrong, it silently
    // corrupts the value: node-postgres sends `host` verbatim as the TLS SNI
    // `servername`, and a servername with leading whitespace makes Neon's
    // (and presumably any SNI-routing proxy's) TLS layer reject the
    // handshake with an opaque "SSL alert number 47 (illegal_parameter)" —
    // a confusing failure mode with no hint that the real problem is a
    // pasted/typed space in the Host field.
    else if (field.type === 'password') fields[field.key] = String(raw);
    else fields[field.key] = String(raw).trim();
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
    return friendlyApiErrorMessage(err, "Couldn't run the test. Try again.");
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
    return friendlyApiErrorMessage(err, "Couldn't refresh the schema. Try again.");
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
