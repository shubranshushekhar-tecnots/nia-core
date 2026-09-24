/**
 * Master-key rotation — STUB (docs/plans/secret-storage.md Step 2D: "Add
 * the command; it may be a stub that reports what it would do").
 *
 * Full implementation, when built: for every nia_secrets row at an old
 * key_version, decrypt encrypted_data_key with the OLD master key,
 * re-encrypt that same data key with the NEW master key, and update only
 * encrypted_data_key + key_version. ciphertext/iv/auth_tag are never
 * touched — the data key they were encrypted under never changes, only how
 * that data key itself is protected does. This is what makes rotation cheap
 * (no re-encryption of the actual secret) and safe to run in the
 * background without an outage.
 *
 * This stub does not write anything. It reports what a real run would do:
 * how many nia_secrets rows exist per key_version, and (if
 * NIA_SECRET_MASTER_KEY_NEXT is set) confirms that key parses.
 *
 * Run with (from apps/worker/):
 *   pnpm run secrets:rotate
 */
import { CURRENT_KEY_VERSION, parseMasterKey } from "@nia/secrets";
import { getSupabaseServiceClient } from "./lib/secretsMigration.js";

async function main() {
  const supabase = getSupabaseServiceClient();

  const { data: rows, error } = await supabase.from("nia_secrets").select("key_version");
  if (error) {
    throw new Error(`reading nia_secrets failed: ${error.message}`);
  }

  const countsByVersion = new Map<number, number>();
  for (const row of rows ?? []) {
    const v = row.key_version as number;
    countsByVersion.set(v, (countsByVersion.get(v) ?? 0) + 1);
  }

  console.log("--- secrets-rotate (stub) report ---");
  console.log(`Current CURRENT_KEY_VERSION: ${CURRENT_KEY_VERSION}`);
  console.log("nia_secrets rows by key_version:");
  for (const [version, count] of [...countsByVersion.entries()].sort((a, b) => a[0] - b[0])) {
    const flag = version === CURRENT_KEY_VERSION ? "(current)" : "(would be rotated)";
    console.log(`  key_version=${version}: ${count} rows ${flag}`);
  }

  const nextKeyRaw = process.env.NIA_SECRET_MASTER_KEY_NEXT;
  if (!nextKeyRaw) {
    console.log(
      "\nNIA_SECRET_MASTER_KEY_NEXT is not set — nothing further to check. " +
        "Set it to the new master key to validate it parses before a real rotation run.",
    );
    return;
  }

  parseMasterKey(nextKeyRaw); // throws with a clear message if malformed
  const rowsToRotate = [...countsByVersion.entries()]
    .filter(([version]) => version !== CURRENT_KEY_VERSION)
    .reduce((sum, [, count]) => sum + count, 0);

  console.log(`\nNIA_SECRET_MASTER_KEY_NEXT parses OK. A real rotation would re-encrypt ${rowsToRotate} row(s)`);
  console.log("encrypted_data_key column only (ciphertext/iv/auth_tag untouched) and bump key_version. Not implemented — stub only.");
}

main();
