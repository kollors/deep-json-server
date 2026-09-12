import { type Engine, isRef, type PreparedList, type Ref, resolveField } from '../engine.js';
import type { Entity } from '../model.js';
import { childrenOf, nodeAt } from '../query/options.js';
import type { JsonObject, JsonValue } from '../types.js';
import { ownScope, type RestOptions, type Scope, scopeFor, validateNested, validateScope } from './options.js';
export function validateRest(engine: Engine, entity: Entity, options: RestOptions): Map<string, PreparedList> {
  validateScope(entity.root, options.scope);
  validateNested(entity.root, options.scope, options.nested);
  return new Map(Object.entries(options.nested).map(([path, nested]) => [path, engine.prepareOptions(nodeAt(entity.root, path), nested)]));
}
export function project(engine: Engine, ref: Ref, scope: Scope = ownScope, nested: RestOptions['nested'] = {}, prefix = '', plans = new Map<string, PreparedList>()): JsonObject {
  const output: JsonObject = Object.create(null);
  const children = childrenOf(ref.node);
  for (const [key, node] of Object.entries(children)) {
    if (node.writeOnly || (!Object.hasOwn(scope, key) && !(Object.hasOwn(scope, '*') && !node.relation))) continue;
    const value = resolveField(ref, node);
    const selection = scopeFor(scope, key);
    const path = prefix + key;
    if (value === undefined) continue;
    if (isRef(value)) output[key] = project(engine, value, selection, nested, `${path}.`, plans);
    else if (Array.isArray(value) && value.every(isRef) && (value.length > 0 || node.relation || node.base === 'object')) {
      const prepared = plans.get(path) ?? engine.prepareOptions(node, nested[path]);
      plans.set(path, prepared);
      const page = engine.list(value as Ref[], node, nested[path], prepared);
      output[key] = { data: page.data.map((v) => project(engine, v, selection, nested, `${path}.`, plans)), total: page.total };
    } else output[key] = structuredClone(value) as JsonValue;
  }
  // Schemaless REST includes all raw fields, including fields absent in earlier records.
  if (!ref.context.model.explicit && scope['*'] === true)
    for (const [key, value] of Object.entries(ref.value)) if (!Object.hasOwn(output, key) && !children[key]?.relation) output[key] = structuredClone(value);
  return output;
}
