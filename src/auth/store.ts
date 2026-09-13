import { JSONFile } from 'lowdb/node';
import { domainError } from '../core/errors.js';
import { createSerialQueue, hasOnlyKeys, isObject } from '../core/utils.js';
import { type AuthConfig, type AuthUserRecord, MAX_USERNAME_LENGTH } from './contract.js';
import { validPasswordHash } from './password.js';

export type StoredUser = Readonly<Required<AuthUserRecord>>;
export interface UserIndex {
  byId: ReadonlyMap<string, StoredUser>;
  byUsername: ReadonlyMap<string, StoredUser>;
}

/** Проверяет записи и строит индексы по двум уникальным строковым ключам.
 * @example Две записи с разными id и username → два индекса; повторяющийся ключ → ошибка.
 */
function indexUsers(records: unknown): UserIndex {
  if (!Array.isArray(records)) throw new Error('Auth users must be an array');
  const byId = new Map<string, StoredUser>();
  const byUsername = new Map<string, StoredUser>();
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
    if (byId.has(record.id) || byUsername.has(record.username)) throw new Error('Auth user ids and usernames must be unique');
    const user = Object.freeze({ id: record.id, username: record.username, passwordHash: record.passwordHash, isAdmin: record.isAdmin ?? false });
    byId.set(user.id, user);
    byUsername.set(user.username, user);
  }
  return { byId, byUsername };
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

  /** Проверяет изменение внутри очереди и публикует его после записи; обработчик подтверждения вызывается синхронно.
   * @example Успешная запись → новый пользователь; ошибка файла → прежние индексы, обработчик не вызван.
   */
  update(operation: (users: UserIndex) => StoredUser, committed?: () => void): Promise<StoredUser> {
    return this.schedule(async () => {
      const user = Object.freeze(operation(this.users));
      const owner = this.users.byUsername.get(user.username);
      if (owner && owner.id !== user.id) throw domainError('CONFLICT', 'Username already exists');
      const byId = new Map(this.users.byId);
      const byUsername = new Map(this.users.byUsername);
      const previous = byId.get(user.id);
      if (previous) byUsername.delete(previous.username);
      byId.set(user.id, user);
      byUsername.set(user.username, user);
      if (this.file) await this.file.write([...byId.values()]);
      this.users = { byId, byUsername };
      committed?.();
      return user;
    });
  }
}

/** Загружает массив из файла или памяти и подключает запись в тот же источник.
 * @example Массив → хранилище в памяти; 'users.json' → чтение и сохранение JSON-массива через JSONFile.
 */
export async function createAuthStore(source: AuthConfig['users']): Promise<AuthStore> {
  const file = typeof source === 'string' ? new JSONFile<StoredUser[]>(source) : undefined;
  const records = file ? await file.read() : source;
  if (file && records === null) throw new Error(`Auth users file not found: ${source}`);
  return new AuthStore(indexUsers(records), file);
}
