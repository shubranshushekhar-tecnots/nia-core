import crypto from 'node:crypto';

/**
 * Small, self-contained RFC 6238 TOTP implementation using only Node's
 * built-in crypto — no otplib/speakeasy dependency exists anywhere in this
 * repo, and importing better-auth's own internal `@better-auth/utils/otp`
 * would be an undeclared/phantom dependency for apps/web (which only
 * depends on `better-auth` directly). Shared by auth-2fa.spec.ts and
 * console-enroll.spec.ts (docs/plans/console-plan.md §4b) rather than
 * duplicated — both need to compute a real code from a secret minted by
 * the real Better Auth API mid-test.
 */

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error(`invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

export function generateTOTP(base32Secret: string, digitCount = 6, period = 30, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / period);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const key = base32Decode(base32Secret);
  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binCode =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(binCode % 10 ** digitCount).padStart(digitCount, '0');
}
