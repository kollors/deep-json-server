import type { Node } from '../core/model.js';
import { badQuery, childrenOf, type ListOptions } from '../core/query/options.js';
import { hasOnlyKeys, isObject, isSafeKey } from '../core/utils.js';
export interface Fields {
  [key: string]: Scope | true;
}
export type TupleScope = [Fields, ListOptions?];
export interface UnionScope {
  union: Scope[];
}
export type Scope = TupleScope | UnionScope;
export interface RestOptions {
  scope: unknown;
}
export const ownScope: TupleScope = [{ '*': true }];
/** Определяет специальный scope, объединяющий несколько обычных выборок списка.
 * @example { union: [[{ id: true }], [{ name: true }]] } → true.
 */
export function isUnionScope(scope: Scope): scope is UnionScope {
  return !Array.isArray(scope);
}
/** Выбирает вложенный набор полей; для отсутствующего поля или true возвращает выбор собственных полей.
 * @example scopeFor([{ '*': true }], 'name') → [{ '*': true }].
 */
export function scopeFor(scope: TupleScope, key: string): Scope {
  const selection = Object.hasOwn(scope[0], key) ? scope[0][key] : true;
  return selection === true || selection === undefined ? ownScope : selection;
}
/** Читает JSON-значение выбора полей из единственного параметра URL; проверяет длину и синтаксис JSON.
 * @example parseRestOptions({ scope: '[{"id":true}]' }) → { scope: [{ id: true }] }.
 */
export function parseRestOptions(query: unknown): RestOptions {
  if (!isObject(query)) badQuery('Invalid query');
  for (const key of Object.keys(query)) if (key !== 'scope') badQuery(`Unknown query parameter ${key}`);
  if (query.scope === undefined) return { scope: ownScope };
  if (typeof query.scope !== 'string') badQuery('scope must occur once and contain JSON');
  if (query.scope.length > 10000) badQuery('scope must contain at most 10000 characters');
  try {
    return { scope: JSON.parse(query.scope) };
  } catch {
    badQuery('Invalid JSON in scope');
  }
}
/** Проверяет выбор полей рекурсивно; аргументы разрешены только для однородных списков.
 * @example Для узла со строковым id: [{ id: true }] → undefined; [{ missing: true }] → ошибка.
 */
export function validateScope(node: Node, scope: unknown, list = false, depth = 0): asserts scope is Scope {
  if (depth > 32) badQuery('scope is too deep');
  if (isObject(scope) && Object.hasOwn(scope, 'union')) {
    if (!list || node.mixed) badQuery('scope union requires a list with consistent object types');
    if (!hasOnlyKeys(scope, ['union']) || !Array.isArray(scope.union) || scope.union.length < 1) badQuery('scope union must contain scopes');
    for (const item of scope.union) validateScope(node, item, true, depth + 1);
    return;
  }
  if (!Array.isArray(scope) || scope.length < 1 || scope.length > 2 || !isObject(scope[0])) badQuery('scope must be [fields, arguments?]');
  if (scope.length === 2) {
    if (!list || node.mixed) badQuery('scope arguments require a list with consistent object types');
    if (!isObject(scope[1]) || !hasOnlyKeys(scope[1], ['where', 'order', 'pager'])) badQuery('Invalid scope arguments');
  }
  const children = childrenOf(node);
  for (const [key, selection] of Object.entries(scope[0])) {
    if (key === '*') {
      if (selection !== true) badQuery('scope wildcard must be true');
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !isSafeKey(key)) badQuery(`Invalid scope field ${key}`);
    const child = children[key];
    if (!Object.hasOwn(children, key) || !child || child.writeOnly || child.implicit) badQuery(`Unknown or inaccessible scope field ${key}`);
    if (child.relation || child.base === 'object') validateScope(child, selection, child.many, depth + 1);
    else if (selection !== true) badQuery(`Scalar field ${key} must be true`);
  }
}
