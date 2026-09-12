import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { MAX_PASSWORD_LENGTH } from './contract.js';

// OWASP scrypt profile: N=2^14, r=8, p=5 (16 MiB memory).
const PREFIX = 'scrypt$16384$8$5';
const HASH_PATTERN = /^scrypt\$16384\$8\$5\$([0-9a-f]{32})\$([0-9a-f]{64})$/;
export const validPasswordHash = (value: unknown): value is string => typeof value === 'string' && HASH_PATTERN.test(value);
const derive = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16384, r: 8, p: 5 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || !password.length || password.length > MAX_PASSWORD_LENGTH) throw new Error(`Password must contain 1..${MAX_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `${PREFIX}$${salt.toString('hex')}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = HASH_PATTERN.exec(encoded);
  if (!parts) return false;
  const actual = await derive(password, Buffer.from(parts[1], 'hex'));
  return timingSafeEqual(actual, Buffer.from(parts[2], 'hex'));
}
export const DUMMY_HASH = `${PREFIX}$${'0'.repeat(32)}$${'0'.repeat(64)}`;
