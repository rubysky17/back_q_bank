import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with PBKDF2-SHA256 from WebCrypto (native code: no library, works in workerd and Node).
 *
 * Stored format: `pbkdf2-sha256$<iterations>$<salt>$<hash>` (base64url). The iteration count travels
 * with each hash, so raising PASSWORD_HASH_ITERATIONS upgrades old hashes on their next sign-in.
 *
 * CPU cost is linear in the iteration count (~0.24 ms per 1,000): 25,000 fits the Free plan's 10 ms
 * budget; 100,000 is the most Workers' WebCrypto accepts.
 */
const ALGORITHM = 'pbkdf2-sha256';
export const MIN_ITERATIONS = 10_000;
export const MAX_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Buffer> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS,
  );
  return Buffer.from(bits);
}

interface ParsedHash {
  iterations: number;
  salt: Buffer;
  hash: Buffer;
}

/** null for anything that is not one of our hashes (e.g. the legacy '!' placeholder). */
function parse(stored: string): ParsedHash | null {
  const [algorithm, rounds, salt, hash] = stored.split('$');
  const iterations = Number(rounds);
  if (
    algorithm !== ALGORITHM ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > MAX_ITERATIONS ||
    !salt ||
    !hash
  ) {
    return null;
  }
  return {
    iterations,
    salt: Buffer.from(salt, 'base64url'),
    hash: Buffer.from(hash, 'base64url'),
  };
}

export async function hashPassword(
  password: string,
  iterations: number,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, iterations);
  return [
    ALGORITHM,
    iterations,
    salt.toString('base64url'),
    hash.toString('base64url'),
  ].join('$');
}

/** Constant-time check. Unknown formats never match. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  const hash = await derive(password, parsed.salt, parsed.iterations);
  return (
    hash.length === parsed.hash.length && timingSafeEqual(hash, parsed.hash)
  );
}

/** True when the hash was made with fewer iterations than currently configured. */
export function needsRehash(stored: string, iterations: number): boolean {
  const parsed = parse(stored);
  return !parsed || parsed.iterations < iterations;
}

/**
 * Burns the same CPU as a real check. Used when the email is unknown, so response time does not
 * reveal which emails have an account.
 */
export async function simulatePasswordCheck(
  password: string,
  iterations: number,
): Promise<void> {
  await derive(password, new Uint8Array(SALT_BYTES), iterations);
}
