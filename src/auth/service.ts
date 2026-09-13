import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { domainError } from '../core/errors.js';
import { hasOnlyKeys, isObject } from '../core/utils.js';
import { type AuthConfig, type AuthSession, type AuthUser, type AuthUserRecord, DEFAULT_SESSION_SECONDS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from './contract.js';
import { DUMMY_HASH, validPasswordHash, verifyPassword } from './password.js';

/** Создаёт исключение отсутствия действительной сессии без раскрытия причины отказа.
 * @example unauthorized() → Error с code = 'UNAUTHENTICATED'.
 */
const unauthorized = () => domainError('UNAUTHENTICATED', 'Invalid credentials or expired session');
/** Вычисляет SHA-256 строки в шестнадцатеричном виде для хранения вместо исходного токена.
 * @example tokenKey('abc') → 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.
 */
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');
/** Возвращает публичные поля пользователя в новом объекте; отсутствие isAdmin означает false.
 * @example publicUser({ id: '1', username: 'anna' }) → { id: '1', username: 'anna', isAdmin: false }.
 */
const publicUser = (user: { id: string; username: string; isAdmin?: boolean }): AuthUser => ({ id: user.id, username: user.username, isAdmin: user.isAdmin ?? false });
interface Session {
  user: AuthUser;
  expiresAt: number;
}
export class AuthService {
  private sessions = new Map<string, Session>();
  private pendingLogins = 0;
  private closed = false;
  constructor(
    private users: Map<string, AuthUserRecord>,
    private expiresIn: number,
  ) {}

  /** Проверяет пароль, создаёт сессию и возвращает токен с публичными данными пользователя.
   * @example Корректные username и password → { accessToken, expiresIn, user }; неверный пароль → исключение.
   */
  async login(body: unknown): Promise<AuthSession> {
    if (
      !isObject(body) ||
      !hasOnlyKeys(body, ['username', 'password']) ||
      typeof body.username !== 'string' ||
      !body.username.length ||
      body.username.length > MAX_USERNAME_LENGTH ||
      typeof body.password !== 'string' ||
      !body.password.length ||
      body.password.length > MAX_PASSWORD_LENGTH
    )
      throw domainError('INVALID_INPUT', 'Supply username and password');
    if (this.closed) throw unauthorized();
    if (this.pendingLogins >= 4) throw domainError('TOO_MANY_REQUESTS', 'Too many simultaneous login attempts');
    this.pendingLogins++;
    let user: AuthUserRecord | undefined;
    let valid: boolean;
    try {
      user = this.users.get(body.username);
      valid = await verifyPassword(body.password, user?.passwordHash ?? DUMMY_HASH);
    } finally {
      this.pendingLogins--;
    }
    if (!user || !valid || this.closed) throw unauthorized();
    this.prune();
    if (this.sessions.size >= 10000) throw domainError('TOO_MANY_REQUESTS', 'Session limit reached');
    const accessToken = randomBytes(32).toString('base64url');
    const identity = publicUser(user);
    this.sessions.set(tokenKey(accessToken), { user: identity, expiresAt: Date.now() + this.expiresIn * 1000 });
    return { accessToken, expiresIn: this.expiresIn, user: publicUser(identity) };
  }
  /** Проверяет Bearer-токен и возвращает копию публичных данных пользователя.
   * @example Заголовок 'Bearer <действительный токен>' → { id, username, isAdmin }.
   */
  me(authorization: unknown): AuthUser {
    const [, session] = this.session(authorization);
    return publicUser(session.user);
  }
  /** Проверяет токен и удаляет соответствующую сессию.
   * @example Действительный токен → { success: true }; повторный выход с ним → ошибка.
   */
  logout(authorization: unknown): { success: boolean } {
    const [key] = this.session(authorization);
    this.sessions.delete(key);
    return { success: true };
  }
  /** Запрещает новые входы и очищает учётные записи и сессии в памяти.
   * @example close() → undefined; последующий login() → отказ.
   */
  close(): void {
    this.closed = true;
    this.sessions.clear();
    this.users.clear();
  }
  /** Находит сессию по хешу токена и проверяет срок; просроченную сессию удаляет.
   * @example Действительный Bearer-токен → [ключ, сессия]; отсутствующий или истёкший → ошибка.
   */
  private session(authorization: unknown): [string, Session] {
    if (typeof authorization !== 'string') throw unauthorized();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
    if (!match) throw unauthorized();
    const key = tokenKey(match[1]);
    const session = this.sessions.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      throw unauthorized();
    }
    return [key, session];
  }
  /** Удаляет из памяти сессии, срок которых истёк к текущему моменту.
   * @example Одна истёкшая и одна действующая сессия → остаётся одна действующая; результат undefined.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }
}
/** Читает и проверяет учётные записи из массива или файла и создаёт хранилище сессий в памяти.
 * @example createAuthService({ users: [] }) → Promise<AuthService>; повторяющиеся id → ошибка.
 */
export async function createAuthService(config: AuthConfig): Promise<AuthService> {
  const records: unknown = typeof config.users === 'string' ? JSON.parse(await readFile(config.users, 'utf8')) : config.users;
  if (!Array.isArray(records)) throw new Error('Auth users must be an array');
  const users = new Map<string, AuthUserRecord>();
  const ids = new Set<string>();
  for (const record of records) {
    if (
      !isObject(record) ||
      !hasOnlyKeys(record, ['id', 'username', 'passwordHash', 'isAdmin']) ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      typeof record.username !== 'string' ||
      !record.username.trim() ||
      record.username.length > MAX_USERNAME_LENGTH ||
      !validPasswordHash(record.passwordHash) ||
      (record.isAdmin !== undefined && typeof record.isAdmin !== 'boolean')
    )
      throw new Error('Auth users require id, username and a valid passwordHash');
    if (ids.has(record.id) || users.has(record.username)) throw new Error('Auth user ids and usernames must be unique');
    ids.add(record.id);
    users.set(record.username, { id: record.id, username: record.username, passwordHash: record.passwordHash, isAdmin: record.isAdmin ?? false });
  }
  return new AuthService(users, config.expiresIn ?? DEFAULT_SESSION_SECONDS);
}
