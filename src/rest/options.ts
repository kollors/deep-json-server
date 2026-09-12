import type { Node } from '../model.js';
import { pathParts } from '../model.js';
import { badQuery, childrenOf, type ListOptions, nodeAt } from '../query/options.js';
import { isObject, isSafeKey } from '../utils.js';
export interface Scope {
  [key: string]: Scope | true;
}
export interface RestOptions extends ListOptions {
  scope: Scope;
  nested: Record<string, ListOptions>;
}
export const ownScope: Scope = { '*': true };
export function scopeFor(scope: Scope, key: string): Scope {
  const selection = Object.hasOwn(scope, key) ? scope[key] : true;
  return selection === true ? ownScope : selection;
}
export function parseRestOptions(query: unknown, list: boolean): RestOptions {
  if (!isObject(query)) badQuery('Invalid query');
  const allowed = list ? ['scope', 'nested', 'where', 'order', 'pager'] : ['scope', 'nested'];
  for (const key of Object.keys(query)) if (!allowed.includes(key)) badQuery(`Unknown query parameter ${key}`);
  const result: RestOptions = { scope: ownScope, nested: {} };
  for (const key of ['scope', 'where', 'order', 'pager', 'nested'] as const) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string') badQuery(`${key} must occur once and contain JSON`);
    if (key === 'scope' && query[key].length > 10000) badQuery('scope must contain at most 10000 characters');
    try {
      result[key] = JSON.parse(query[key]) as never;
    } catch {
      badQuery(`Invalid JSON in ${key}`);
    }
  }
  if (!isObject(result.nested)) badQuery('nested must be an object');
  return result;
}
export function validateScope(node: Node, scope: unknown, depth = 0): asserts scope is Scope {
  if (!isObject(scope)) badQuery('scope must be a JSON object');
  if (depth > 32) badQuery('scope is too deep');
  for (const [key, selection] of Object.entries(scope)) {
    if (key === '*') {
      if (selection !== true) badQuery('scope wildcard must be true');
      continue;
    }
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key) || !isSafeKey(key)) badQuery(`Invalid scope field ${key}`);
    if (selection !== true && !isObject(selection)) badQuery(`scope.${key} must be true or an object`);
    const child = childrenOf(node)[key];
    if (!Object.hasOwn(childrenOf(node), key) || child.writeOnly) badQuery(`Unknown or inaccessible scope field ${key}`);
    if (selection !== true) {
      if (!child.relation && child.base !== 'object') badQuery(`Scalar field ${key} cannot have a selection`);
      validateScope(child, selection, depth + 1);
    }
  }
}
export function validateNested(root: Node, scope: Scope, nested: Record<string, ListOptions>): void {
  for (const [path, options] of Object.entries(nested)) {
    const node = nodeAt(root, path);
    if (!node.many || (!node.relation && node.base !== 'object')) badQuery(`nested.${path} must address an object list`);
    if (!isObject(options) || Object.keys(options).some((k) => !['where', 'order', 'pager'].includes(k))) badQuery(`Invalid nested options at ${path}`);
    let current = root;
    let selection = scope;
    for (const key of pathParts(path)) {
      const child = childrenOf(current)[key];
      if (!Object.hasOwn(selection, key) && !(Object.hasOwn(selection, '*') && !child.relation)) badQuery(`nested path ${path} is not selected by scope`);
      selection = scopeFor(selection, key);
      current = child;
    }
  }
}
