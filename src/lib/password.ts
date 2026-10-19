import { scrypt, timingSafeEqual, randomBytes } from 'node:crypto';

const N_DEFAULT = 32768;
export const MIN_PASSWORD_LENGTH = 10;

function scryptAsync(pw: string, salt: Buffer, keylen: number, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(pw, salt, keylen, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (err, key) => (err ? reject(err) : resolve(key)))
  );
}

// Format: scrypt$N$saltB64$hashB64
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, N_DEFAULT);
  return `scrypt$${N_DEFAULT}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function isValidHashFormat(stored: string): boolean {
  const p = stored.split('$');
  return p.length === 4 && p[0] === 'scrypt' && /^\d+$/.test(p[1]);
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 16384 || N > 1048576 || (N & (N - 1)) !== 0) return false;
  const salt = Buffer.from(parts[2], 'base64');
  const expected = Buffer.from(parts[3], 'base64');
  if (expected.length < 32) return false;
  try {
    const actual = await scryptAsync(password, salt, expected.length, N);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Used when the username doesn't exist, so timing matches a real check.
export const DUMMY_HASH = `scrypt$${N_DEFAULT}$${randomBytes(16).toString('base64')}$${randomBytes(64).toString('base64')}`;
