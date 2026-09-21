import type { DatabaseData, DatabaseSnapshot, JsonValue, SnapshotValue } from './types.js';

const frozenSnapshots = new WeakSet<object>();

/** Замораживает дерево JSON на месте; пропускает только уже обработанные этой функцией поддеревья.
 * @example freezeSnapshot({ rows: [{ id: 1 }] }) → тот же объект; rows.push(...) затем выбрасывает TypeError.
 */
export function freezeSnapshot(value: DatabaseSnapshot): DatabaseSnapshot;
export function freezeSnapshot(value: SnapshotValue): SnapshotValue;
export function freezeSnapshot(value: unknown): unknown {
  if (value && typeof value === 'object' && !frozenSnapshots.has(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
    frozenSnapshots.add(value);
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
