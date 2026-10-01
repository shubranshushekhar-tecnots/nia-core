import { createCipheriv, createDecipheriv, randomBytes, type CipherGCM, type DecipherGCM } from "node:crypto";
import { MASTER_KEY_LENGTH_BYTES } from "../secrets/crypto.js";

/**
 * Spool chunk files sit on disk holding raw customer row data while a sync
 * is in flight, so every chunk's gzipped NDJSON bytes are encrypted at rest
 * with the agent's existing local master key (same key/keyfile as
 * secrets/crypto.ts, AES-256-GCM) before ever touching the filesystem —
 * plaintext customer data must never be readable from a spool file.
 *
 * The on-disk layout is a flat binary envelope (not the JSON EncryptedBlob
 * shape secrets/crypto.ts uses) because chunk writes are streamed rather
 * than built as one in-memory buffer:
 *   [12-byte IV][GCM ciphertext ...][16-byte auth tag]
 * chunkUploader.ts reads a whole chunk file back in one shot before
 * uploading, so decryption (and the test-only encrypt helper below) just
 * operates on a single Buffer.
 */
const ALGORITHM = "aes-256-gcm";
export const SPOOL_IV_LENGTH_BYTES = 12;
export const SPOOL_AUTH_TAG_LENGTH_BYTES = 16;

/** Used by SpoolWriter to encrypt each chunk file as it streams to disk. */
export function createSpoolCipher(masterKey: Buffer): { iv: Buffer; cipher: CipherGCM } {
  assertKeyLength(masterKey);
  const iv = randomBytes(SPOOL_IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv) as CipherGCM;
  return { iv, cipher };
}

/** One-shot counterpart to createSpoolCipher, for callers (tests) that need a complete encrypted buffer rather than a stream. */
export function encryptSpoolBuffer(masterKey: Buffer, plaintext: Buffer): Buffer {
  assertKeyLength(masterKey);
  const iv = randomBytes(SPOOL_IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey, iv) as CipherGCM;
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

/** Used by chunkUploader.ts before upload. Throws (authTag mismatch) if the file was truncated, corrupted, or tampered with. */
export function decryptSpoolBuffer(masterKey: Buffer, raw: Buffer): Buffer {
  assertKeyLength(masterKey);
  if (raw.length < SPOOL_IV_LENGTH_BYTES + SPOOL_AUTH_TAG_LENGTH_BYTES) {
    throw new Error("spool file is too short to contain a valid envelope");
  }
  const iv = raw.subarray(0, SPOOL_IV_LENGTH_BYTES);
  const authTag = raw.subarray(raw.length - SPOOL_AUTH_TAG_LENGTH_BYTES);
  const ciphertext = raw.subarray(SPOOL_IV_LENGTH_BYTES, raw.length - SPOOL_AUTH_TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGORITHM, masterKey, iv) as DecipherGCM;
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== MASTER_KEY_LENGTH_BYTES) {
    throw new Error(`master key must be ${MASTER_KEY_LENGTH_BYTES} bytes, got ${key.length}`);
  }
}
