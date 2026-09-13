import { bindingFor, childName, type Entity, type Model, type Node, readPath } from './model.js';
import type { DatabaseData, JsonObject } from './types.js';
import { isObject } from './utils.js';

const REF = Symbol('record reference');
export interface Ref {
  [REF]: true;
  entity: Entity;
  node: Node;
  value: JsonObject;
  root: JsonObject;
  bindings: Record<string, JsonObject>;
  context: Context;
}
export interface Context {
  data: DatabaseData;
  model: Model;
  indexes: Map<string, Map<string, JsonObject[]>>;
}
/** Создаёт контекст чтения с пустым кешем индексов; данные и модель передаются по ссылке.
 * @example makeContext(data, model) → { data, model, indexes: Map(0) }.
 */
export const makeContext = (data: DatabaseData, model: Model): Context => ({ data, model, indexes: new Map() });
/** Оборачивает запись ссылкой с контекстом и корневым узлом без копирования записи.
 * @example rootRef(context, entity, row).value → row; .bindings → {}.
 */
export const rootRef = (context: Context, entity: Entity, value: JsonObject): Ref => ({ [REF]: true, context, entity, node: entity.root, value, root: value, bindings: {} });
/** Строит ключ скалярного значения с префиксом типа, различая числа и строки.
 * @example keyOf(1) → 'number:1'; keyOf('1') → 'string:1'.
 */
export const keyOf = (value: unknown): string => `${typeof value}:${String(value)}`;
/** Читает ключи связи из ближайшего вложенного объекта или из корневой записи.
 * @example При source = 'authorId' и записи { authorId: 7 } → [7].
 */
export function sourceValues(ref: Ref, node: Node): unknown[] {
  const path = node.source as string;
  const binding = bindingFor(ref.bindings, path);
  return binding ? readPath(ref.bindings[binding], path === binding ? [] : path.slice(binding.length + 1)) : readPath(ref.root, path);
}
/** Находит связанные записи по сопоставленным ключам и кеширует индекс в контексте; убирает повторы.
 * @example Ключи [1, 1, 2] при двух совпавших записях → две ссылки на записи.
 */
export function related(ref: Ref, node: Node): Ref[] {
  const entity = node.relation as Entity;
  const indexKey = `${entity.collection}:${node.target}`;
  let index = ref.context.indexes.get(indexKey);
  if (!index) {
    index = new Map();
    for (const record of ref.context.data[entity.collection] ?? [])
      for (const value of readPath(record, node.target as string)) {
        const key = keyOf(value);
        const bucket = index.get(key) ?? [];
        bucket.push(record);
        index.set(key, bucket);
      }
    ref.context.indexes.set(indexKey, index);
  }
  const found = new Set<JsonObject>();
  for (const value of sourceValues(ref, node)) for (const record of index.get(keyOf(value)) ?? []) found.add(record);
  return [...found].map((record) => rootRef(ref.context, entity, record));
}
/** Возвращает значение поля или ссылки на связанные объекты, учитывая отсутствующие и удалённые записи.
 * @example Для обычного name в записи { name: 'Анна' } → 'Анна'; отсутствующая одиночная связь → null.
 */
export function resolveField(ref: Ref, node: Node, includeDeleted = false): unknown {
  if (node.relation) {
    const records = related(ref, node).filter((record) => node.many || includeDeleted || !record.entity.softDelete || record.value.deletedAt == null);
    return node.many ? records : (records[0] ?? null);
  }
  const key = childName(node);
  const value = Object.hasOwn(ref.value, key) ? ref.value[key] : node.system && !node.internal ? null : undefined;
  if ((ref.context.model.explicit && node.base !== 'object') || value == null) return value;
  const wrap = (object: JsonObject): Ref => ({ ...ref, node, value: object, bindings: { ...ref.bindings, [node.path]: object } });
  if (Array.isArray(value)) return value.map((item) => (isObject(item) ? wrap(item as JsonObject) : item));
  return isObject(value) ? wrap(value as JsonObject) : value;
}
/** Проверяет наличие внутренней метки ссылки на запись.
 * @example isRef({ id: '1' }) → false; isRef(rootRef(context, entity, row)) → true.
 */
export const isRef = (value: unknown): value is Ref => isObject(value) && (value as Partial<Ref>)[REF] === true;
