import type { Engine, PreparedList } from '../core/engine.js';
import type { Actor } from '../core/lifecycle/options.js';
import type { Entity, Node } from '../core/model.js';
import { childrenOf } from '../core/query/options.js';
import { isRef, type Ref, resolveField } from '../core/records.js';
import type { JsonObject, JsonValue } from '../core/types.js';
import { defined } from '../core/utils.js';
import { isUnionScope, ownScope, type RestOptions, type Scope, scopeFor, type TupleScope, validateScope } from './options.js';

/** Допускает в неявный выбор только примитивное значение, не скрытое метаданными поля.
 * @example wildcardValue({ relationKey: true, … }, 1) → false; wildcardValue(undefined, 'Анна') → true.
 */
function wildcardValue(node: Node | undefined, value: unknown): boolean {
  return (
    !node?.writeOnly &&
    !node?.relation &&
    !node?.relationKey &&
    (!node || node.mixed || (!node.many && node.base !== 'object')) &&
    (value === null || ['string', 'number', 'boolean'].includes(typeof value))
  );
}

export interface ScopedPage {
  data: Array<{ ref: Ref; scope: TupleScope }>;
  total: number;
}
/** Проверяет дерево выбора и заранее подготавливает фильтры, сортировку и пагинацию вложенных списков.
 * @example Выбор без аргументов у одиночной записи → { scope, plans: Map(0) }; неверное поле → ошибка.
 */
export function validateRest(engine: Engine, entity: Entity, options: RestOptions, list = false): { scope: Scope; plans: Map<TupleScope | Node, PreparedList> } {
  validateScope(entity.root, options.scope, list);
  const plans = new Map<TupleScope | Node, PreparedList>();
  if (list && !isUnionScope(options.scope)) plans.set(options.scope, engine.prepareOptions(entity.root, options.scope[1]));
  const visit = (node: Node, scope: Scope): void => {
    if (isUnionScope(scope)) {
      for (const item of scope.union) {
        if (!isUnionScope(item) && item[1]) plans.set(item, engine.prepareOptions(node, item[1]));
        visit(node, item);
      }
      return;
    }
    for (const [key, selection] of Object.entries(scope[0])) {
      if (selection === true) continue;
      const child = defined(childrenOf(node)[key], key);
      if (!isUnionScope(selection) && selection[1]) plans.set(selection, engine.prepareOptions(child, selection[1]));
      visit(child, selection);
    }
  };
  visit(entity.root, options.scope);
  return { scope: options.scope, plans };
}
/** Выполняет обычный или объединённый scope списка, сохраняя порядок частей и первую запись с каждым ключом.
 * @example Две части с id 1, затем id 1 и 2 → данные [1, 2], total 2.
 */
export function listScope(engine: Engine, records: Ref[], node: Node, scope: Scope, plans: Map<TupleScope | Node, PreparedList>, planKey?: TupleScope | Node): ScopedPage {
  if (!isUnionScope(scope)) {
    const key = planKey ?? scope;
    const prepared = plans.get(key) ?? engine.prepareOptions(node, scope[1]);
    plans.set(key, prepared);
    const page = engine.list(records, node, scope[1], prepared);
    return { data: page.data.map((ref) => ({ ref, scope })), total: page.total };
  }
  const seen = new Set<unknown>();
  const data: ScopedPage['data'] = [];
  for (const item of scope.union) {
    for (const entry of listScope(engine, records, node, item, plans).data) {
      const key = entry.ref.node === entry.ref.entity.root ? entry.ref.value[entry.ref.entity.primary] : entry.ref.value;
      if (seen.has(key)) continue;
      seen.add(key);
      data.push(entry);
    }
  }
  return { data, total: data.length };
}
/** Строит новый объект из выбранных полей, разворачивая связи и обрабатывая вложенные списки.
 * @example Запись { id: '1', name: 'Анна' } и выбор [{ name: true }] → { name: 'Анна' }.
 */
export function project(engine: Engine, ref: Ref, scope: Scope = ownScope, plans = new Map<TupleScope | Node, PreparedList>(), actor?: Actor): JsonObject {
  if (isUnionScope(scope)) throw new Error('scope union cannot select a single record');
  const output: JsonObject = Object.create(null);
  const children = childrenOf(ref.node);
  for (const [key, node] of Object.entries(children)) {
    const wildcard = scope[0]['*'] === true && wildcardValue(node, ref.value[key] === undefined && node.system && !node.internal && !node.virtual ? null : ref.value[key]);
    if (node.writeOnly || (!Object.hasOwn(scope[0], key) && !wildcard)) continue;
    const value = resolveField(ref, node, false, actor);
    const selection = scopeFor(scope, key);
    if (value === undefined) continue;
    if (isRef(value)) output[key] = project(engine, value, selection, plans, actor);
    else if (Array.isArray(value)) {
      if (value.every(isRef) && (value.length > 0 || node.relation || node.base === 'object')) {
        const page = listScope(engine, value, node, selection, plans, isUnionScope(selection) ? undefined : selection === ownScope ? node : selection);
        output[key] = { data: page.data.map((entry) => project(engine, entry.ref, entry.scope, plans, actor)), total: page.total };
      } else output[key] = value.map((item) => (isRef(item) ? project(engine, item, selection, plans, actor) : structuredClone(item))) as JsonValue;
    } else output[key] = structuredClone(value) as JsonValue;
  }
  // При выведенной модели добавляем исходные скаляры, которые не удалось описать.
  if (!ref.context.model.explicit && scope[0]['*'] === true)
    for (const [key, value] of Object.entries(ref.value)) if (!Object.hasOwn(output, key) && wildcardValue(children[key], value)) output[key] = structuredClone(value);
  return output;
}
