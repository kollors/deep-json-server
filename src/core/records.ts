import { type Actor, recordActions } from './lifecycle/options.js';
import { bindingFor, childName, readPath, requireRelation } from './model/tree.js';
import type { Entity, Model, Node } from './model/types.js';
import type { RecordSnapshot } from './types.js';
import { isObject } from './utils.js';

const REF = Symbol('record reference');
export interface Ref<R extends RecordSnapshot = RecordSnapshot> {
  [REF]: true;
  entity: Entity;
  node: Node;
  value: R;
  root: R;
  bindings: Record<string, R>;
  context: Context<R>;
}
export interface Context<R extends RecordSnapshot = RecordSnapshot> {
  data: Readonly<Record<string, readonly R[]>>;
  model: Model;
  indexes: Map<string, Map<string, R[]>>;
}
/** Создаёт контекст чтения с пустым кешем индексов; данные и модель передаются по ссылке.
 * @example makeContext(data, model) → { data, model, indexes: Map(0) }.
 */
export const makeContext = <R extends RecordSnapshot>(data: Readonly<Record<string, readonly R[]>>, model: Model): Context<R> => ({ data, model, indexes: new Map() });
/** Оборачивает запись ссылкой с контекстом и корневым узлом без копирования записи.
 * @example rootRef(context, entity, row).value → row; .bindings → {}.
 */
export const rootRef = <R extends RecordSnapshot>(context: Context<R>, entity: Entity, value: R): Ref<R> => ({ [REF]: true, context, entity, node: entity.root, value, root: value, bindings: {} });
/** Строит ключ скалярного значения с префиксом типа, различая числа и строки.
 * @example keyOf(1) → 'number:1'; keyOf('1') → 'string:1'.
 */
export const keyOf = (value: unknown): string => `${typeof value}:${String(value)}`;
/** Читает ключи связи из ближайшего вложенного объекта или из корневой записи.
 * @example При source = 'authorId' и записи { authorId: 7 } → [7].
 */
export function sourceValues(ref: Ref, node: Node): unknown[] {
  const path = requireRelation(node).source;
  const binding = bindingFor(ref.bindings, path);
  return binding ? readPath(ref.bindings[binding], path === binding ? [] : path.slice(binding.length + 1)) : readPath(ref.root, path);
}
/** Находит связанные записи по сопоставленным ключам и кеширует индекс в контексте; убирает повторы.
 * @example Ключи [1, 1, 2] при двух совпавших записях → две ссылки на записи.
 */
export function related<R extends RecordSnapshot>(ref: Ref<R>, node: Node): Ref<R>[] {
  const relation = requireRelation(node);
  const entity = relation.relation;
  const indexKey = `${entity.collection}:${node.target}`;
  let index = ref.context.indexes.get(indexKey);
  if (!index) {
    index = new Map();
    for (const record of ref.context.data[entity.collection] ?? [])
      for (const value of readPath(record, relation.target)) {
        const key = keyOf(value);
        const bucket = index.get(key) ?? [];
        bucket.push(record);
        index.set(key, bucket);
      }
    ref.context.indexes.set(indexKey, index);
  }
  const found = new Set<R>();
  for (const value of sourceValues(ref, node)) for (const record of index.get(keyOf(value)) ?? []) found.add(record);
  return [...found].map((record) => rootRef(ref.context, entity, record));
}
/** Возвращает значение поля или ссылки на связанные объекты, учитывая отсутствующие и удалённые записи.
 * @example Для обычного name в записи { name: 'Анна' } → 'Анна'; отсутствующая одиночная связь → null.
 */
export function resolveField(ref: Ref, node: Node, includeDeleted = false, actor?: Actor): unknown {
  if (node.relation) {
    const records = related(ref, node).filter((record) => node.many || includeDeleted || !record.entity.softDelete || record.value.deletedAt == null);
    return node.many ? records : (records[0] ?? null);
  }
  const wrap = (object: RecordSnapshot): Ref => ({ ...ref, node, value: object, bindings: { ...ref.bindings, [node.path]: object } });
  if (node.virtual === 'actions') return wrap(recordActions(actor, ref.root));
  const key = childName(node);
  const value = Object.hasOwn(ref.value, key) ? ref.value[key] : node.system && !node.internal ? null : undefined;
  if ((ref.context.model.explicit && node.base !== 'object') || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => (isObject(item) ? wrap(item as RecordSnapshot) : item));
  return isObject(value) ? wrap(value as RecordSnapshot) : value;
}
/** Проверяет наличие внутренней метки ссылки на запись.
 * @example isRef({ id: '1' }) → false; isRef(rootRef(context, entity, row)) → true.
 */
export const isRef = (value: unknown): value is Ref => isObject(value) && (value as Partial<Ref>)[REF] === true;
