/**
 * One-off, idempotent backfill: docs/plans/secret-storage.md Step 2C.
 *
 * Copies every Vault secret CURRENTLY REFERENCED by
 * connections.vault_secret_ref or write_grants.write_credential_vault_ref
 * into nia_secrets, under the SAME id as the legacy Vault ref — so
 * SecretStore.get(ref) finds it in nia_secrets on the first lookup from
 * then on, with zero changes needed to the connections/write_grants rows
 * themselves (the ref value never changes).
 *
 * Deliberately does NOT migrate every row in vault.secrets. Per the
 * approved plan addition, past credential edits (connections.ts's
 * updateConnection) have always left the pre-edit Vault row behind — every
 * successful edit orphans one. Those orphans are not migrated here; this
 * script only reports how many there are (see the report at the end),
 * using count_vault_secrets() (0033_count_vault_secrets_rpc.sql) minus the
 * distinct refs actually in use. See TODO.md for the follow-up (delete the
 * old secret on a successful edit going forward) and the equivalent
 * nia_write_* role gap left by grant rotation.
 *
 * Idempotent: a ref already present in nia_secrets (by id) is skipped, so
 * re-running costs one extra SELECT per already-migrated ref and nothing
 * else. Safe to re-run after a partial/failed run.
 *
 * Verifies every migrated row before counting it done: immediately re-reads
 * what it just wrote, decrypts it, and compares it to the plaintext read
 * from Vault moments earlier. A mismatch is reported and the ref is left
 * Vault-only (not retried automatically) rather than silently counted as
 * migrated.
 *
 * Vault rows are never touched (no update, no delete) — removal is a
 * separate, later step (TODO.md).
 *
 * Run with (from apps/worker/):
 *   pnpm run secrets:backfill
 * Reads SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / NIA_SECRET_MASTER_KEY
 * from apps/worker/.env (via dotenv/config) or the environment.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptSecret, decryptSecret, CURRENT_KEY_VERSION, type EncryptedSecret } from "@nia/secrets";
import { getSupabaseServiceClient, getMasterKey, collectSecretRefTasks, type SecretRefTask } from "./lib/secretsMigration.js";

export type MigrateOneResult = "already-migrated" | "migrated" | "failed";

/** Exported for unit testing (secrets-backfill.test.ts) — pure decision logic, one ref at a time. */
export async function migrateOne(
  supabase: SupabaseClient,
  masterKey: Buffer,
  task: SecretRefTask,
): Promise<MigrateOneResult> {
  const { data: existing, error: existingErr } = await supabase
    .from("nia_secrets")
    .select("id")
    .eq("id", task.ref)
    .maybeSingle();
  if (existingErr) {
    console.error(`SKIP ${task.ref}: nia_secrets lookup failed: ${existingErr.message}`);
    return "failed";
  }
  if (existing) {
    return "already-migrated";
  }

  const { data: plaintextData, error: rpcErr } = await supabase.rpc("resolve_connector_secret", { p_ref: task.ref });
  if (rpcErr || plaintextData == null) {
    console.error(`SKIP ${task.ref}: Vault resolve failed: ${rpcErr?.message ?? "no data returned"}`);
    return "failed";
  }
  const plaintext = plaintextData as Record<string, unknown>;

  const encrypted = encryptSecret(masterKey, CURRENT_KEY_VERSION, plaintext);
  const { error: insertErr } = await supabase.from("nia_secrets").insert({
    id: task.ref,
    ciphertext: encrypted.ciphertext,
    encrypted_data_key: encrypted.encryptedDataKey,
    iv: encrypted.iv,
    auth_tag: encrypted.authTag,
    algorithm: encrypted.algorithm,
    key_version: encrypted.keyVersion,
    org_id: task.scope.org_id ?? undefined,
    owner_id: task.scope.owner_id ?? undefined,
  });
  if (insertErr) {
    console.error(`FAIL ${task.ref}: nia_secrets insert failed: ${insertErr.message}`);
    return "failed";
  }

  const { data: writtenRow, error: readBackErr } = await supabase
    .from("nia_secrets")
    .select("ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version")
    .eq("id", task.ref)
    .single();
  if (readBackErr || !writtenRow) {
    console.error(`FAIL ${task.ref}: post-write readback failed: ${readBackErr?.message ?? "no row"}`);
    return "failed";
  }

  const encryptedReadBack: EncryptedSecret = {
    ciphertext: writtenRow.ciphertext,
    encryptedDataKey: writtenRow.encrypted_data_key,
    iv: writtenRow.iv,
    authTag: writtenRow.auth_tag,
    algorithm: writtenRow.algorithm,
    keyVersion: writtenRow.key_version,
  };
  const decrypted = decryptSecret(masterKey, encryptedReadBack);
  if (JSON.stringify(decrypted) !== JSON.stringify(plaintext)) {
    console.error(
      `FAIL ${task.ref}: decrypted nia_secrets value does not match the Vault source. ` +
        `Vault row left intact, NOT marking migrated — investigate manually.`,
    );
    return "failed";
  }

  return "migrated";
}

async function main() {
  const supabase = getSupabaseServiceClient();
  const masterKey = getMasterKey();

  const tasks = await collectSecretRefTasks(supabase);
  const distinctRefs = [...new Set(tasks.map((t) => t.ref))];
  const taskByRef = new Map(tasks.map((t) => [t.ref, t]));

  let alreadyMigrated = 0;
  let newlyMigrated = 0;
  let failed = 0;

  for (const ref of distinctRefs) {
    const task = taskByRef.get(ref)!;
    const result = await migrateOne(supabase, masterKey, task);
    if (result === "already-migrated") alreadyMigrated++;
    else if (result === "migrated") newlyMigrated++;
    else failed++;
  }

  console.log("--- secrets-backfill report ---");
  console.log(`Referenced refs (distinct):  ${distinctRefs.length}`);
  console.log(`Already migrated (skipped):  ${alreadyMigrated}`);
  console.log(`Newly migrated this run:     ${newlyMigrated}`);
  console.log(`Failed:                      ${failed}`);

  const { data: totalVaultSecrets, error: countErr } = await supabase.rpc("count_vault_secrets");
  if (countErr) {
    console.error(`Could not fetch total Vault secret count: ${countErr.message}`);
  } else if (typeof totalVaultSecrets === "number") {
    const orphanCount = totalVaultSecrets - distinctRefs.length;
    console.log(`Total Vault secrets (all-time, incl. orphans): ${totalVaultSecrets}`);
    console.log(`Orphaned Vault secrets (never referenced by a live ref): ${orphanCount}`);
  }

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// Guarded so secrets-backfill.test.ts can import migrateOne without
// triggering a real run (which needs live env vars + network access).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
