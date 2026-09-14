import type { Source, Storage } from '../core/storage.js';
export interface AuthUser {
  id: string;
  username: string;
  isAdmin: boolean;
}
export interface AuthUserRecord extends Omit<AuthUser, 'isAdmin'> {
  isAdmin?: boolean;
  passwordHash: string;
}
export interface AuthConfig<S extends Storage = Storage> {
  source: Source<S, AuthUserRecord[]>;
  /** Session lifetime in seconds. Defaults to one hour. */
  expiresIn?: number;
}
export interface AuthSession {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}
export const AUTH_PATHS = {
  login: '/auth/login',
  register: '/auth/register',
  me: '/auth/me',
  logout: '/auth/logout',
  password: '/auth/users/:id/password',
  admin: '/auth/users/:id/admin',
} as const;
export const DEFAULT_SESSION_SECONDS = 3600;
export const MAX_USERNAME_LENGTH = 256;
export const MAX_PASSWORD_LENGTH = 1024;
