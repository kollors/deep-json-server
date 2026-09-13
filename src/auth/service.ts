import { createHash, randomBytes } from 'node:crypto';
import { domainError } from '../core/errors.js';
import { createUniqueId } from '../core/utils.js';
import { type AuthConfig, type AuthSession, type AuthUser, DEFAULT_SESSION_SECONDS } from './contract.js';
import { adminChange, credentials, passwordChange } from './input.js';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password.js';
import { type AuthStore, createAuthStore, type StoredUser, type UserIndex } from './store.js';

/** Создаёт исключение отсутствия действительной сессии без раскрытия причины отказа.
 * @example unauthorized() → Error с code = 'UNAUTHENTICATED'.
 */
const unauthorized = () => domainError('UNAUTHENTICATED', 'Invalid credentials or expired session');
/** Вычисляет SHA-256 строки в шестнадцатеричном виде для хранения вместо исходного токена.
 * @example tokenKey('abc') → 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'.
 */
const tokenKey = (token: string) => createHash('sha256').update(token).digest('hex');
/** Возвращает публичные поля пользователя в новом объекте.
 * @example { id: '1', username: 'anna', isAdmin: false, passwordHash: '…' } → { id: '1', username: 'anna', isAdmin: false }.
 */
const publicUser = (user: StoredUser): AuthUser => ({ id: user.id, username: user.username, isAdmin: user.isAdmin });
interface Session {
  userId: string;
  expiresAt: number;
}
export class AuthService {
  private sessions = new Map<string, Session>();
  private pendingPasswords = 0;
  private closed = false;
  constructor(
    private store: AuthStore,
    private expiresIn: number,
  ) {}

  /** Проверяет пароль и создаёт сессию с актуальными правами пользователя.
   * @example Корректные username и password → { accessToken, expiresIn, user }; неверный пароль → исключение.
   */
  async login(body: unknown): Promise<AuthSession> {
    const { username, password } = credentials(body);
    const user = this.store.read().byUsername.get(username);
    const valid = await this.passwordWork(() => verifyPassword(password, user?.passwordHash ?? DUMMY_HASH));
    this.assertOpen();
    const current = user && this.store.read().byId.get(user.id);
    // Смена пароля во время scrypt не должна выдавать новую сессию по прежнему паролю.
    if (!user || !valid || !current || current.passwordHash !== user.passwordHash) throw unauthorized();
    this.prune();
    if (this.sessions.size >= 10000) throw domainError('TOO_MANY_REQUESTS', 'Session limit reached');
    const accessToken = randomBytes(32).toString('base64url');
    this.sessions.set(tokenKey(accessToken), { userId: current.id, expiresAt: Date.now() + this.expiresIn * 1000 });
    return { accessToken, expiresIn: this.expiresIn, user: publicUser(current) };
  }

  /** Создаёт обычного пользователя с новым идентификатором и хешем пароля, не открывая сессию.
   * @example { username: 'anna', password: 'secret' } → { id: '…', username: 'anna', isAdmin: false }.
   */
  async register(body: unknown): Promise<AuthUser> {
    const { username, password } = credentials(body);
    const passwordHash = await this.passwordWork(() => hashPassword(password));
    const user = await this.store.update((users) => {
      this.assertOpen();
      return { id: createUniqueId((id) => users.byId.has(id)), username, passwordHash, isAdmin: false };
    });
    return publicUser(user);
  }

  /** Меняет свой пароль после проверки текущего либо пароль обычного пользователя по правам администратора.
   * @example Свой id и два пароля → { success: true } с завершением всех своих сессий; чужой администратор → FORBIDDEN.
   */
  async changePassword(authorization: unknown, id: string, body: unknown): Promise<{ success: boolean }> {
    const { actor, target } = this.passwordTarget(this.store.read(), authorization, id);
    const { newPassword, currentPassword } = passwordChange(body);
    const own = actor.id === target.id;
    if (own && currentPassword === undefined) throw domainError('INVALID_INPUT', 'Supply currentPassword to change your own password');
    const passwordHash = await this.passwordWork(async () => {
      if (own && !(await verifyPassword(currentPassword as string, target.passwordHash))) throw unauthorized();
      return hashPassword(newPassword);
    });
    await this.store.update(
      (users) => {
        const { target: current } = this.passwordTarget(users, authorization, id);
        if (current.passwordHash !== target.passwordHash) throw domainError('CONFLICT', 'Password changed during the request');
        return { ...current, passwordHash };
      },
      () => this.revoke(id),
    );
    return { success: true };
  }

  /** Меняет статус по правам действующего администратора и сохраняет хотя бы одного при отказе от собственных прав.
   * @example Последний администратор и { isAdmin: false } для себя → CONFLICT; назначение другого → обновлённый пользователь.
   */
  async changeAdmin(authorization: unknown, id: string, body: unknown): Promise<AuthUser> {
    this.requireAdmin(authorization);
    const isAdmin = adminChange(body);
    const user = await this.store.update((users) => {
      const actor = this.requireAdmin(authorization);
      const target = users.byId.get(id);
      if (!target) throw domainError('NOT_FOUND', 'Auth user not found');
      if (!isAdmin && actor.id === target.id && ![...users.byId.values()].some((user) => user.id !== id && user.isAdmin))
        throw domainError('CONFLICT', 'The last administrator cannot remove their own admin status');
      return { ...target, isAdmin };
    });
    return publicUser(user);
  }

  /** Проверяет токен и возвращает копию пользователя с текущими правами.
   * @example После снятия статуса прежний токен возвращает isAdmin: false без повторного входа.
   */
  me(authorization: unknown): AuthUser {
    return publicUser(this.identity(authorization));
  }
  /** Проверяет токен и удаляет соответствующую сессию.
   * @example Действительный токен → { success: true }; повторный выход с ним → ошибка.
   */
  logout(authorization: unknown): { success: boolean } {
    const [key] = this.session(authorization);
    this.sessions.delete(key);
    return { success: true };
  }
  /** Запрещает новые обращения и очищает сессии в памяти.
   * @example close() → undefined; последующий login() → отказ.
   */
  close(): void {
    this.closed = true;
    this.sessions.clear();
  }

  /** Ограничивает число одновременных вычислений хешей и освобождает место даже при ошибке.
   * @example Четыре незавершённых вычисления → пятое получает TOO_MANY_REQUESTS.
   */
  private async passwordWork<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    if (this.pendingPasswords >= 4) throw domainError('TOO_MANY_REQUESTS', 'Too many simultaneous password operations');
    this.pendingPasswords++;
    try {
      return await operation();
    } finally {
      this.pendingPasswords--;
    }
  }
  /** Отклоняет обращения после закрытия сервиса.
   * @example closed = true → UNAUTHENTICATED; false → undefined.
   */
  private assertOpen(): void {
    if (this.closed) throw unauthorized();
  }
  /** Находит сессию по хешу токена и проверяет срок; просроченную сессию удаляет.
   * @example Действительный Bearer-токен → [ключ, сессия]; отсутствующий или истёкший → ошибка.
   */
  private session(authorization: unknown): [string, Session] {
    this.assertOpen();
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
  /** Получает текущую запись по идентификатору из проверенной сессии.
   * @example Сессия с userId = '1' → актуальная запись с id = '1'; отсутствующая запись → ошибка.
   */
  private identity(authorization: unknown): StoredUser {
    const [, session] = this.session(authorization);
    const user = this.store.read().byId.get(session.userId);
    if (!user) throw unauthorized();
    return user;
  }
  /** Проверяет текущие права администратора.
   * @example Действующая сессия обычного пользователя → FORBIDDEN; администратора → его запись.
   */
  private requireAdmin(authorization: unknown): StoredUser {
    const user = this.identity(authorization);
    if (!user.isAdmin) throw domainError('FORBIDDEN', 'Administrator access required');
    return user;
  }
  /** Проверяет владельца пароля и запрет изменения пароля другого администратора.
   * @example Администратор и обычная чужая запись → { actor, target }; два разных администратора → FORBIDDEN.
   */
  private passwordTarget(users: UserIndex, authorization: unknown, id: string): { actor: StoredUser; target: StoredUser } {
    const actor = this.identity(authorization);
    if (actor.id !== id && !actor.isAdmin) throw domainError('FORBIDDEN', 'You can only change your own password');
    const target = users.byId.get(id);
    if (!target) throw domainError('NOT_FOUND', 'Auth user not found');
    if (actor.id !== id && target.isAdmin) throw domainError('FORBIDDEN', 'Cannot change another administrator password');
    return { actor, target };
  }
  /** Завершает все сессии одного пользователя после сохранения нового пароля.
   * @example Две сессии id = '1' и одна id = '2' → остаётся сессия id = '2'.
   */
  private revoke(id: string): void {
    for (const [key, session] of this.sessions) if (session.userId === id) this.sessions.delete(key);
  }
  /** Удаляет из памяти сессии, срок которых истёк к текущему моменту.
   * @example Одна истёкшая и одна действующая сессия → остаётся одна действующая; результат undefined.
   */
  private prune(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }
}
/** Открывает источник учётных записей и создаёт хранилище сессий в памяти.
 * @example createAuthService({ users: [] }) → Promise<AuthService>; повторяющиеся id → ошибка.
 */
export async function createAuthService(config: AuthConfig): Promise<AuthService> {
  return new AuthService(await createAuthStore(config.users), config.expiresIn ?? DEFAULT_SESSION_SECONDS);
}
