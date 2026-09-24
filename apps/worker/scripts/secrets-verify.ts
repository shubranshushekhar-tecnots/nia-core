/**
 * Read-only verification for the Vault -> nia_secrets backfill
 * (docs/plans/secret-storage.md Step 2C). Never writes anything. Per the
 * plan, this must report a clean pass (zero mismatches) before any later
 * step is allowed to touch a Vault row.
 *
 * Reports:
 *   - total: distinct refs currently live on connections.vault_secret_ref /
 *     write_grants.write_credential_vault_ref
 *   - inBoth: how many of those already have a matching nia_secrets row.
 *     Vault rows are never deleted by the backfill, so a migrated ref
 *     genuinely exists in both stores right now, by design.
 *   - vaultOnly: how many are still Vault-only (not yet backfilled)
 *   - mismatches: for every "inBoth" ref, decrypts the nia_secrets row and
 *     compares it field-for-field to what Vault's resolve_connector_secret
 *     RPC returns for the same ref right now. Should always be zero — a
 *     mismatch means either backfill's own verify step missed a bug, or a
 *     row was altered after migration.
 *
 * Run with (from apps/worker/):
 *   pnpm run secrets:verify
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSecret, type EncryptedSecret } from "@nia/secrets";
import { getSupabaseServiceClient, getMasterKey, collectSecretRefTasks } from "./lib/secretsMigration.js";

export type VerifyOneResult = "in-both-match" | "in-both-mismatch" | "vault-only" | "error";

/** Exported for unit testing (secrets-verify.test.ts) — pure decision logic, one ref at a time. */
export async function verifyOne(supabase: SupabaseClient, masterKey: Buffer, ref: string): Promise<VerifyOneResult> {
  const { data: niaRow, error: niaErr } = await supabase
    .from("nia_secrets")
    .select("ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version")
    .eq("id", ref)
    .maybeSingle();
  if (niaErr) {
    console.error(`ERROR ${ref}: nia_secrets lookup failed: ${niaErr.message}`);
    return "error";
  }

  if (!niaRow) {
    return "vault-only";
  }

  const { data: plaintextData, error: rpcErr } = await supabase.rpc("resolve_connector_secret", { p_ref: ref });
  if (rpcErr || plaintextData == null) {
    console.error(`MISMATCH ${ref}: migrated to nia_secrets, but Vault resolve failed: ${rpcErr?.message ?? "no data returned"}`);
    return "in-both-mismatch";
  }

  const encrypted: EncryptedSecret = {
    ciphertext: niaRow.ciphertext,
    encryptedDataKey: niaRow.encrypted_data_key,
    iv: niaRow.iv,
    authTag: niaRow.auth_tag,
    algorithm: niaRow.algorithm,
    keyVersion: niaRow.key_version,
  };

  let decrypted: Record<string, unknown>;
  try {
    decrypted = decryptSecret(masterKey, encrypted);
  } catch (err) {
    console.error(`MISMATCH ${ref}: nia_secrets row failed to decrypt: ${(err as Error).message}`);
    return "in-both-mismatch";
  }

  if (JSON.stringify(decrypted) !== JSON.stringify(plaintextData)) {
    console.error(`MISMATCH ${ref}: nia_secrets value does not match the current Vault value.`);
    return "in-both-mismatch";
  }

  return "in-both-match";
}

async function main() {
  const supabase = getSupabaseServiceClient();
  const masterKey = getMasterKey();

  const tasks = await collectSecretRefTasks(supabase);
  const distinctRefs = [...new Set(tasks.map((t) => t.ref))];

  let inBoth = 0;
  let vaultOnly = 0;
  let mismatches = 0;

  for (const ref of distinctRefs) {
    const result = await verifyOne(supabase, masterKey, ref);
    if (result === "vault-only") vaultOnly++;
    else if (result === "in-both-match") inBoth++;
    else if (result === "in-both-mismatch") {
      inBoth++;
      mismatches++;
    } else {
      mismatches++;
    }
  }

  const { data: totalVaultSecrets, error: countErr } = await supabase.rpc("count_vault_secrets");

  console.log("--- secrets-verify report ---");
  console.log(`Referenced refs (distinct, total): ${distinctRefs.length}`);
  console.log(`In both (migrated):                ${inBoth}`);
  console.log(`Vault only (not yet migrated):      ${vaultOnly}`);
  console.log(`Mismatches:                         ${mismatches}`);
  if (!countErr && typeof totalVaultSecrets === "number") {
    console.log(`Total Vault secrets (all-time, incl. orphans): ${totalVaultSecrets}`);
    console.log(`Orphaned Vault secrets (never referenced by a live ref): ${totalVaultSecrets - distinctRefs.length}`);
  }

  if (mismatches > 0) {
    console.error("\nFAIL: mismatches found — do not proceed to touch any Vault row until this is clean.");
    process.exitCode = 1;
  } else {
    console.log("\nPASS: no mismatches.");
  }
}

// Guarded so secrets-verify.test.ts can import verifyOne without triggering
// a real run (which needs live env vars + network access).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
