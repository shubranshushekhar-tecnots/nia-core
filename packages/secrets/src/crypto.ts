import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption (docs/plans/secret-storage.md Step 2A). Every secret
 * gets its own random 256-bit data key; the data key (not the secret) is
 * what NIA_SECRET_MASTER_KEY encrypts. AES-256-GCM at both layers, a fresh
 * random IV per encryption (never reused), auth tags stored alongside their
 * ciphertext so tampering or a wrong key fails loudly instead of returning
 * garbage.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH_BYTES = 32; // AES-256
const IV_LENGTH_BYTES = 12; // recommended GCM nonce size
const GCM_AUTH_TAG_LENGTH_BYTES = 16;

export interface EncryptedSecret {
  /** Base64 AES-256-GCM ciphertext of the secret, encrypted under the per-secret data key. */
  ciphertext: string;
  /** Base64 packed [dataKeyIv | dataKeyAuthTag | encryptedDataKey] — the data key encrypted under the master key. */
  encryptedDataKey: string;
  /** Base64 IV used to encrypt the secret itself. */
  iv: string;
  /** Base64 GCM auth tag for the secret's own ciphertext. */
  authTag: string;
  algorithm: string;
  keyVersion: number;
}

/**
 * Parses and validates NIA_SECRET_MASTER_KEY. Throws with a clear,
 * actionable message on anything malformed — callers should let this
 * exception fail the service's boot, per docs/plans/secret-storage.md
 * Step 2D ("fails to start if NIA_SECRET_MASTER_KEY is missing or malformed").
 */
export function parseMasterKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim().length === 0) {
    throw new Error(
      "NIA_SECRET_MASTER_KEY is not set. Generate one with: openssl rand -base64 32",
    );
  }

  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    throw new Error(
      "NIA_SECRET_MASTER_KEY is not valid base64. Generate one with: openssl rand -base64 32",
    );
  }

  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(
      `NIA_SECRET_MASTER_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes (got ${key.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return key;
}

/** Encrypts `secret` with a fresh random data key, then encrypts that data key with `masterKey`. */
export function encryptSecret(
  masterKey: Buffer,
  keyVersion: number,
  secret: Record<string, unknown>,
): EncryptedSecret {
  const dataKey = randomBytes(KEY_LENGTH_BYTES);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");

  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const dataKeyIv = randomBytes(IV_LENGTH_BYTES);
  const dataKeyCipher = createCipheriv(ALGORITHM, masterKey, dataKeyIv);
  const encryptedDataKeyBytes = Buffer.concat([dataKeyCipher.update(dataKey), dataKeyCipher.final()]);
  const dataKeyAuthTag = dataKeyCipher.getAuthTag();

  // Packed as one column: [iv | authTag | ciphertext] so key_version alone
  // identifies which master key can unpack it — no separate columns needed
  // for the data-key layer's own iv/tag.
  const encryptedDataKey = Buffer.concat([dataKeyIv, dataKeyAuthTag, encryptedDataKeyBytes]);

  return {
    ciphertext: ciphertext.toString("base64"),
    encryptedDataKey: encryptedDataKey.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    algorithm: ALGORITHM,
    keyVersion,
  };
}

/**
 * Reverses encryptSecret. Throws (rather than returning garbage) when
 * `masterKey` is wrong, `encrypted` was tampered with, or the algorithm is
 * unrecognized — GCM's auth tag makes any of these fail at decrypt time.
 */
export function decryptSecret(masterKey: Buffer, encrypted: EncryptedSecret): Record<string, unknown> {
  if (encrypted.algorithm !== ALGORITHM) {
    throw new Error(`Unsupported secret algorithm: ${encrypted.algorithm}`);
  }

  const packedDataKey = Buffer.from(encrypted.encryptedDataKey, "base64");
  const dataKeyIv = packedDataKey.subarray(0, IV_LENGTH_BYTES);
  const dataKeyAuthTag = packedDataKey.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);
  const encryptedDataKeyBytes = packedDataKey.subarray(IV_LENGTH_BYTES + GCM_AUTH_TAG_LENGTH_BYTES);

  const dataKeyDecipher = createDecipheriv(ALGORITHM, masterKey, dataKeyIv);
  dataKeyDecipher.setAuthTag(dataKeyAuthTag);
  const dataKey = Buffer.concat([dataKeyDecipher.update(encryptedDataKeyBytes), dataKeyDecipher.final()]);

  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const authTag = Buffer.from(encrypted.authTag, "base64");

  const decipher = createDecipheriv(ALGORITHM, dataKey, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
}
