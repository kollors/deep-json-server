import type { Engine, PreparedList } from '../core/engine.js';
import type { Entity, Node } from '../core/model.js';
import { childrenOf } from '../core/query/options.js';
import { isRef, type Ref, resolveField } from '../core/records.js';
import type { JsonObject, JsonValue } from '../core/types.js';
import { ownScope, type RestOptions, type Scope, scopeFor, validateScope } from './options.js';
/** Проверяет дерево выбора и заранее подготавливает фильтры, сортировку и пагинацию вложенных списков.
 * @example Выбор без аргументов у одиночной записи → пустая Map; неверное поле → ошибка.
 */
export function validateRest(engine: Engine, entity: Entity, options: RestOptions, list = false): Map<Scope | Node, PreparedList> {
  validateScope(entity.root, options.scope, list);
  const plans = new Map<Scope | Node, PreparedList>();
  if (list) plans.set(options.scope, engine.prepareOptions(entity.root, options.scope[1]));
  const visit = (node: Node, scope: Scope): void => {
    for (const [key, selection] of Object.entries(scope[0])) {
      if (selection === true) continue;
      const child = childrenOf(node)[key];
      if (selection[1]) plans.set(selection, engine.prepareOptions(child, selection[1]));
      visit(child, selection);
    }
  };
  visit(entity.root, options.scope);
  return plans;
}
/** Строит новый объект из выбранных полей, разворачивая связи и обрабатывая вложенные списки.
 * @example Запись { id: '1', name: 'Анна' } и выбор [{ name: true }] → { name: 'Анна' }.
 */
export function project(engine: Engine, ref: Ref, scope: Scope = ownScope, plans = new Map<Scope | Node, PreparedList>()): JsonObject {
  const output: JsonObject = Object.create(null);
  const children = childrenOf(ref.node);
  for (const [key, node] of Object.entries(children)) {
    if (node.writeOnly || (!Object.hasOwn(scope[0], key) && !(Object.hasOwn(scope[0], '*') && !node.relation))) continue;
    const value = resolveField(ref, node);
    const selection = scopeFor(scope, key);
    if (value === undefined) continue;
    if (isRef(value)) output[key] = project(engine, value, selection, plans);
    else if (Array.isArray(value)) {
      if (value.every(isRef) && (value.length > 0 || node.relation || node.base === 'object')) {
        const planKey = selection === ownScope ? node : selection;
        const prepared = plans.get(planKey) ?? engine.prepareOptions(node, selection[1]);
        plans.set(planKey, prepared);
        const page = engine.list(value as Ref[], node, selection[1], prepared);
        output[key] = { data: page.data.map((v) => project(engine, v, selection, plans)), total: page.total };
      } else output[key] = value.map((item) => (isRef(item) ? project(engine, item, selection, plans) : structuredClone(item))) as JsonValue;
    } else output[key] = structuredClone(value) as JsonValue;
  }
  // При выведенной модели добавляем исходные поля, которые не удалось описать.
  if (!ref.context.model.explicit && scope[0]['*'] === true)
    for (const [key, value] of Object.entries(ref.value)) if (!Object.hasOwn(output, key) && !children[key]?.relation && !children[key]?.writeOnly) output[key] = structuredClone(value);
  return output;
}
