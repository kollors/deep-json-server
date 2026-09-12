import { childName, type Entity, type Model, type Node, readPath } from './model.js';
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
export const makeContext = (data: DatabaseData, model: Model): Context => ({ data, model, indexes: new Map() });
export const rootRef = (context: Context, entity: Entity, value: JsonObject): Ref => ({ [REF]: true, context, entity, node: entity.root, value, root: value, bindings: {} });
export const keyOf = (value: unknown): string => `${typeof value}:${String(value)}`;
export function sourceValues(ref: Ref, node: Node): unknown[] {
  const path = node.source as string;
  const binding = Object.keys(ref.bindings)
    .filter((prefix) => path === prefix || path.startsWith(`${prefix}.`))
    .sort((a, b) => b.length - a.length)[0];
  return binding ? readPath(ref.bindings[binding], path === binding ? [] : path.slice(binding.length + 1)) : readPath(ref.root, path);
}
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
export function resolveField(ref: Ref, node: Node): unknown {
  if (node.relation) {
    const records = related(ref, node);
    return node.many ? records : (records[0] ?? null);
  }
  const key = childName(node);
  const value = Object.hasOwn(ref.value, key) ? ref.value[key] : undefined;
  if ((ref.context.model.explicit && node.base !== 'object') || value == null) return value;
  const wrap = (object: JsonObject): Ref => ({ ...ref, node, value: object, bindings: { ...ref.bindings, [node.path]: object } });
  if (Array.isArray(value)) return value.every(isObject) ? (value as JsonObject[]).map(wrap) : value;
  return isObject(value) ? wrap(value as JsonObject) : value;
}
export const isRef = (value: unknown): value is Ref => isObject(value) && (value as Partial<Ref>)[REF] === true;
