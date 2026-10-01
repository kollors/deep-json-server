import { JSONFile } from 'lowdb/node';
import { domainError } from '../core/errors.js';
import { createSerialQueue, defined, hasOnlyKeys, isObject } from '../core/utils.js';
import { type AuthConfig, type AuthSessionRecord, type AuthUserRecord, MAX_USERNAME_LENGTH } from './contract.js';
import { validPasswordHash } from './password.js';

export type StoredUser = Readonly<Omit<Required<AuthUserRecord>, 'sessions'>> & { readonly sessions: readonly Readonly<AuthSessionRecord>[] };
export interface UserIndex {
  byId: ReadonlyMap<string, StoredUser>;
  byUsername: ReadonlyMap<string, StoredUser>;
  byTokenHash: ReadonlyMap<string, Readonly<{ userId: string; expiresAt: number }>>;
}

/** Проверяет записи, отбрасывает истёкшие сессии и строит индексы пользователей и токенов.
 * @example Записи с уникальными id, username и tokenHash → индексы пользователей и сессий; повторяющийся ключ → ошибка.
 */
function indexUsers(records: unknown): UserIndex {
  if (!Array.isArray(records)) throw new Error('Auth users must be an array');
  const byId = new Map<string, StoredUser>();
  const byUsername = new Map<string, StoredUser>();
  const byTokenHash = new Map<string, Readonly<{ userId: string; expiresAt: number }>>();
  const tokenHashes = new Set<string>();
  const now = Date.now();
  for (const record of records) {
    if (
      !isObject(record) ||
      !hasOnlyKeys(record, ['id', 'username', 'passwordHash', 'isAdmin', 'sessions']) ||
      typeof record.id !== 'string' ||
      !record.id.trim() ||
      typeof record.username !== 'string' ||
      !record.username.trim() ||
      record.username.length > MAX_USERNAME_LENGTH ||
      !validPasswordHash(record.passwordHash) ||
      (record.isAdmin !== undefined && typeof record.isAdmin !== 'boolean')
    )
      throw new Error('Auth users require id, username and a valid passwordHash');
    if (byId.has(record.id) || byUsername.has(record.username)) throw new Error('Auth user ids and usernames must be unique');
    if (record.sessions !== undefined && !Array.isArray(record.sessions)) throw new Error('Auth user sessions must be an array');
    const sessions: Readonly<AuthSessionRecord>[] = [];
    for (const session of record.sessions ?? []) {
      if (
        !isObject(session) ||
        !hasOnlyKeys(session, ['tokenHash', 'expiresAt']) ||
        typeof session.tokenHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(session.tokenHash) ||
        typeof session.expiresAt !== 'number' ||
        !Number.isSafeInteger(session.expiresAt) ||
        session.expiresAt <= 0
      )
        throw new Error('Auth user sessions require a SHA-256 tokenHash and a positive integer expiresAt in milliseconds');
      if (tokenHashes.has(session.tokenHash)) throw new Error('Auth user session token hashes must be unique');
      tokenHashes.add(session.tokenHash);
      if (session.expiresAt <= now) continue;
      sessions.push(Object.freeze({ tokenHash: session.tokenHash, expiresAt: session.expiresAt }));
      byTokenHash.set(session.tokenHash, Object.freeze({ userId: record.id, expiresAt: session.expiresAt }));
    }
    const user = Object.freeze({ id: record.id, username: record.username, passwordHash: record.passwordHash, isAdmin: record.isAdmin ?? false, sessions: Object.freeze(sessions) });
    byId.set(user.id, user);
    byUsername.set(user.username, user);
  }
  return { byId, byUsername, byTokenHash };
}

/** Хранит подтверждённые записи и последовательно сохраняет изменения одного пользователя. */
export class AuthStore {
  private schedule = createSerialQueue();
  constructor(
    private users: UserIndex,
    private file?: JSONFile<StoredUser[]>,
  ) {}

  /** Возвращает индексы последнего успешно сохранённого состояния.
   * @example Во время записи нового пароля read() ещё возвращает запись с прежним хешем.
   */
  read(): UserIndex {
    return this.users;
  }

  /** Сохраняет пользователя вместе с сессиями внутри очереди; очищает истёкшие сессии всех пользователей.
   * @example Успешная запись → новые индексы; ошибка файла → прежние пользователи и сессии.
   */
  update(operation: (users: UserIndex) => StoredUser): Promise<StoredUser> {
    return this.schedule(async () => {
      const user = operation(this.users);
      const owner = this.users.byUsername.get(user.username);
      if (owner && owner.id !== user.id) throw domainError('CONFLICT', 'Username already exists');
      const byId = new Map(this.users.byId);
      byId.set(user.id, user);
      const next = indexUsers([...byId.values()]);
      if (this.file) await this.file.write([...next.byId.values()]);
      this.users = next;
      return defined(next.byId.get(user.id), 'updated auth user');
    });
  }
}

/** Загружает массив из файла или памяти и подключает запись в тот же источник.
 * @example Массив → хранилище в памяти; 'users.json' → чтение и сохранение JSON-массива через JSONFile.
 */
export async function createAuthStore(source: AuthConfig['source']): Promise<AuthStore> {
  const file = typeof source === 'string' ? new JSONFile<StoredUser[]>(source) : undefined;
  const records = file ? await file.read() : source;
  if (file && records === null) throw new Error(`Auth users file not found: ${source}`);
  return new AuthStore(indexUsers(records), file);
}
