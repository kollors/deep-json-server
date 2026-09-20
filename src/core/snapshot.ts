import type { DatabaseData, DatabaseSnapshot, JsonValue, SnapshotValue } from './types.js';
/** Замораживает дерево JSON на месте; повторный вызов для готового снимка не обходит его заново.
 * @example freezeSnapshot({ rows: [{ id: 1 }] }) → тот же объект; rows.push(...) затем выбрасывает TypeError.
 */
export function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
/** Копирует снимок в изменяемое дерево, не сохраняя заморозку и ссылки на исходные объекты.
 * @example const copy = cloneSnapshot(frozen); copy.rows.push({ id: 2 }) не меняет frozen.
 */
export function cloneSnapshot(value: DatabaseSnapshot): DatabaseData;
export function cloneSnapshot(value: SnapshotValue): JsonValue;
export function cloneSnapshot(value: unknown): unknown {
  return structuredClone(value);
}
