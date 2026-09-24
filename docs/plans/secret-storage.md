Replace Supabase Vault with our own secret storage. Every connection credential in the product lives here, so correctness matters more than speed: a mistake means every connection breaks and credentials are unrecoverable.
First, save this entire prompt verbatim to docs/plans/secret-storage.md and re-read it if your context is compacted. Report findings before writing code. Don't commit.

Step 0: Confirm the tree is clean apart from the known untracked scratch files. STOP otherwise.

Step 1: Inventory (report, then stop for my approval)
- Every place Vault is used: vault.create_secret, vault.decrypted_secrets, delete, and the RPCs wrapping them, with file:line. Include connector pool managers, the grants service, and the eval sandbox.
- What is stored: connection credentials, write-grant credentials, anything else.
- How a secret is read at runtime: which service, which role, how often, and whether results are cached.
- How many secrets exist in local and remote Supabase (counts only, never values).
STOP if anything reads a secret outside the paths you find, or if any secret is read by the browser.

Step 2: Design (implement after my approval)
A. Envelope encryption
- Each secret gets a fresh random data key; the data key is encrypted with a master key from the environment (NIA_SECRET_MASTER_KEY). Store ciphertext, encrypted data key, algorithm, and master key version.
- Use AES-256-GCM via node:crypto, with a random IV per secret and the auth tag stored. Never reuse an IV.
- The master key never reaches the database, and is never logged.
- One interface (SecretStore) with an env-key implementation now, so an Azure Key Vault implementation can be added later without touching stored secrets.

B. Schema
- A new additive migration: nia_secrets table (id, ciphertext, encrypted_data_key, iv, auth_tag, algorithm, key_version, created_at, org scoping matching existing tables), with RLS following the same pattern as connections.
- No service reads this table directly; everything goes through SecretStore.

C. Migration path, this is the critical part
- Dual-read: SecretStore.get resolves from nia_secrets first, and falls back to Vault when absent. Both work throughout.
- A one-off backfill command copies every Vault secret into nia_secrets, verifying each by decrypting and comparing to the Vault value before marking it migrated. It is idempotent and re-runnable.
- Writes go to nia_secrets only, from the moment this ships.
- Vault rows are not deleted. Removal is a separate, later step once the new path has run in production, and it gets its own command.
- A verification command reports: total secrets, how many exist in both, how many in Vault only, and whether every migrated secret decrypts to the same value. It must pass before Vault is touched.

D. Operational safety
- The service fails to start if NIA_SECRET_MASTER_KEY is missing or malformed, with a clear message.
- Key rotation: since key_version is stored per secret, rotation re-encrypts data keys in the background without re-encrypting secrets. Add the command; it may be a stub that reports what it would do.
- Add the variable to every .env.example and .env.production.example, and to DEPLOYMENT.md, including how to generate a master key and that losing it means losing every stored credential.

Step 3: Tests (exactly these)
- Unit: round trip (encrypt then decrypt returns the original), a wrong master key fails to decrypt rather than returning garbage, and each secret gets a distinct IV.
- Unit: dual-read resolves from nia_secrets when present and falls back to Vault when absent.
- Unit: the backfill is idempotent, and verification detects a value mismatch.
- One live check: after backfill on local Supabase, every existing connection still tests successfully through the connectors.
- Typecheck every package; run the unit suites of changed packages.

Step 4: Close
- docs/decisions.md: an entry covering envelope encryption, why the master key stays out of the database, the dual-read migration, and that Vault removal is a separate later step.
- TODO.md: the Azure Key Vault implementation, and removing the Vault fallback once production has run on the new path.

Output: the Step 1 inventory first, and stop. Then, after approval, deviations with reasons, test counts, and the untruncated git status --porcelain. Don't commit.
