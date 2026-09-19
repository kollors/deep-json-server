import { getBoolean } from '../config-values.js';
import type { JsonObject } from '../types.js';
import { isObject } from '../utils.js';

export interface RecordOptions {
  timestamps?: boolean;
  softDelete?: boolean;
  auth?: boolean;
}
export interface Actor {
  id: string;
  isAdmin?: boolean;
}
export interface RecordActions {
  [key: string]: boolean;
  update: boolean;
  replace: boolean;
  delete: boolean;
}
export type ActorSource = Actor | (() => Actor);
export type Authenticate = (authorization: unknown) => Actor;
export const DELETION_META = 'djsDeletion';
export const AUDIT_FIELDS = ['createdAt', 'updatedAt', 'deletedAt', 'createdById', 'updatedById', 'deletedById'] as const;
/** Проверяет право пользователя изменять существующую запись.
 * @example Владелец записи { createdById: '1' } с actor.id = '1' → true; другой обычный пользователь → false.
 */
export function canChangeRecord(actor: Actor | undefined, record: JsonObject): boolean {
  return !!actor && (!!actor.isAdmin || record.createdById === actor.id);
}
/** Возвращает доступные пользователю операции над записью.
 * @example recordActions(undefined, { createdById: '1' }) → все флаги false; владелец → все флаги true.
 */
export function recordActions(actor: Actor | undefined, record: JsonObject): RecordActions {
  const allowed = canChangeRecord(actor, record);
  return { update: allowed, replace: allowed, delete: allowed };
}
/** Проверяет логические флаги и заменяет отсутствующие значения на false.
 * @example recordOptions({ softDelete: true }) → { timestamps: false, softDelete: true, auth: false }.
 */
export function recordOptions(options: RecordOptions = {}): Required<RecordOptions> {
  return { timestamps: getBoolean(options.timestamps, 'timestamps') ?? false, softDelete: getBoolean(options.softDelete, 'softDelete') ?? false, auth: getBoolean(options.auth, 'auth') ?? false };
}
/** Ищет условие deletedAt на текущем уровне и в логических ветках, не заходя в поля связанных объектов.
 * @example mentionsDeletedAt({ or: [{ deletedAt: { ne: null } }] }) → true; { user: { deletedAt: {} } } → false.
 */
export function mentionsDeletedAt(where: unknown): boolean {
  if (!isObject(where)) return false;
  return Object.hasOwn(where, 'deletedAt') || ['and', 'or'].some((key) => Array.isArray(where[key]) && where[key].some(mentionsDeletedAt)) || mentionsDeletedAt(where.not);
}
