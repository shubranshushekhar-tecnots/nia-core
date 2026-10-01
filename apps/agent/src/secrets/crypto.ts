import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Standalone crypto module for the agent's local secret store — deliberately
 * NOT a reuse of packages/secrets/src/crypto.ts (that one's two-layer
 * envelope encryption exists to let a data key rotate independently of a
 * shared master key across many server-side secrets; the agent has exactly
 * one local master key protecting its own small set of secrets, so a single
 * AES-256-GCM layer is enough — see docs/plans/planometry-integration.md
 * Phase 2 §3).
 */
const ALGORITHM = "aes-256-gcm";
export const MASTER_KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
  algorithm: typeof ALGORITHM;
  /** Lets a future key rotation re-encrypt old blobs without guessing which key encrypted them. */
  keyVersion: number;
}

export function encrypt(masterKey: Buffer, keyVersion: number, data: unknown): EncryptedBlob {
  assertKeyLength(masterKey);
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv);
  const plaintext = Buffer.from(JSON.stringify(data), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    algorithm: ALGORITHM,
    keyVersion,
  };
}

export function decrypt<T = unknown>(masterKey: Buffer, blob: EncryptedBlob): T {
  assertKeyLength(masterKey);
  const decipher = createDecipheriv(ALGORITHM, masterKey, Buffer.from(blob.iv, "base64"));
  decipher.setAuthTag(Buffer.from(blob.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== MASTER_KEY_LENGTH_BYTES) {
    throw new Error(`master key must be ${MASTER_KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
}
