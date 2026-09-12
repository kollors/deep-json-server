export type { AuthConfig, AuthSession, AuthUser, AuthUserRecord } from './contract.js';
/** Creates a salted password hash for an auth user fixture. */
export async function hashPassword(password: string): Promise<string> {
  return (await import('./password.js')).hashPassword(password);
}
