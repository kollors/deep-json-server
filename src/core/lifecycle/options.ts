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
export type Authenticate = (authorization: unknown) => Actor;
export const DELETION_META = 'djsDeletion';
export const AUDIT_FIELDS = ['createdAt', 'updatedAt', 'deletedAt', 'createdById', 'updatedById', 'deletedById'] as const;
/** Проверяет логические флаги и заменяет отсутствующие значения на false.
 * @example recordOptions({ softDelete: true }) → { timestamps: false, softDelete: true, auth: false }.
 */
export function recordOptions(options: RecordOptions = {}): Required<RecordOptions> {
  for (const key of ['timestamps', 'softDelete', 'auth'] as const) if (options[key] !== undefined && typeof options[key] !== 'boolean') throw new Error(`${key} must be boolean`);
  return { timestamps: options.timestamps ?? false, softDelete: options.softDelete ?? false, auth: options.auth ?? false };
}
/** Ищет условие deletedAt на текущем уровне и в логических ветках, не заходя в поля связанных объектов.
 * @example mentionsDeletedAt({ or: [{ deletedAt: { ne: null } }] }) → true; { user: { deletedAt: {} } } → false.
 */
export function mentionsDeletedAt(where: unknown): boolean {
  if (!isObject(where)) return false;
  return Object.hasOwn(where, 'deletedAt') || ['and', 'or'].some((key) => Array.isArray(where[key]) && where[key].some(mentionsDeletedAt)) || mentionsDeletedAt(where.not);
}
