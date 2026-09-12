import type { Node } from '../model.js';
import { badQuery, childrenOf, type ListOptions } from '../query/options.js';
import { isObject, isSafeKey } from '../utils.js';
export interface Fields {
  [key: string]: Scope | true;
}
export type Scope = [Fields, ListOptions?];
export interface RestOptions {
  scope: Scope;
}
export const ownScope: Scope = [{ '*': true }];
export function scopeFor(scope: Scope, key: string): Scope {
  const selection = Object.hasOwn(scope[0], key) ? scope[0][key] : true;
  return selection === true ? ownScope : selection;
}
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
export function validateScope(node: Node, scope: unknown, list = false, depth = 0): asserts scope is Scope {
  if (depth > 32) badQuery('scope is too deep');
  if (!Array.isArray(scope) || scope.length < 1 || scope.length > 2 || !isObject(scope[0])) badQuery('scope must be [fields, arguments?]');
  if (scope.length === 2) {
    if (!list || node.mixed) badQuery('scope arguments require a list with consistent object types');
    if (!isObject(scope[1]) || Object.keys(scope[1]).some((key) => !['where', 'order', 'pager'].includes(key))) badQuery('Invalid scope arguments');
  }
  const children = childrenOf(node);
  for (const [key, selection] of Object.entries(scope[0])) {
    if (key === '*') {
      if (selection !== true) badQuery('scope wildcard must be true');
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !isSafeKey(key)) badQuery(`Invalid scope field ${key}`);
    const child = children[key];
    if (!Object.hasOwn(children, key) || child.writeOnly) badQuery(`Unknown or inaccessible scope field ${key}`);
    if (child.relation || child.base === 'object') validateScope(child, selection, child.many, depth + 1);
    else if (selection !== true) badQuery(`Scalar field ${key} must be true`);
  }
}
