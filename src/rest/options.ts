import type { Node } from '../model.js';
import { pathParts } from '../model.js';
import { badQuery, childrenOf, type ListOptions, nodeAt } from '../query/options.js';
import { isObject } from '../utils.js';
export interface Scope {
  [key: string]: Scope | null;
}
export interface RestOptions extends ListOptions {
  scope: Scope;
  nested: Record<string, ListOptions>;
}
export const ownScope: Scope = { '*': null };
export function parseScope(value: unknown): Scope {
  if (value === undefined) return ownScope;
  if (typeof value !== 'string' || !value.length || value.length > 10000) badQuery('scope must be a nonempty string of at most 10000 characters');
  let index = 0;
  function parse(depth: number): Scope {
    if (depth > 32) badQuery('scope is too deep');
    const result: Scope = Object.create(null);
    while (index < (value as string).length) {
      const match = /^(\*|[A-Za-z][A-Za-z0-9_]*)/.exec((value as string).slice(index));
      if (!match) badQuery('Invalid scope syntax');
      const key = match[1];
      if (key !== '*') pathParts(key);
      index += key.length;
      let child: Scope | null = null;
      if ((value as string)[index] === '(') {
        if (key === '*') badQuery('Wildcard cannot have a selection');
        index++;
        child = parse(depth + 1);
        if ((value as string)[index++] !== ')') badQuery('Unclosed scope selection');
      }
      if (Object.hasOwn(result, key)) badQuery(`Duplicate scope field ${key}`);
      result[key] = child;
      if ((value as string)[index] !== ',') break;
      index++;
      if (index === (value as string).length) badQuery('Trailing scope comma');
    }
    if (!Object.keys(result).length) badQuery('Empty scope selection');
    return result;
  }
  const result = parse(0);
  if (index !== value.length) badQuery('Invalid scope syntax');
  return result;
}
export function parseRestOptions(query: unknown, list: boolean): RestOptions {
  if (!isObject(query)) badQuery('Invalid query');
  const allowed = list ? ['scope', 'nested', 'where', 'order', 'pager'] : ['scope', 'nested'];
  for (const key of Object.keys(query)) if (!allowed.includes(key)) badQuery(`Unknown query parameter ${key}`);
  const result: RestOptions = { scope: parseScope(query.scope), nested: {} };
  for (const key of ['where', 'order', 'pager', 'nested'] as const) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string') badQuery(`${key} must occur once and contain JSON`);
    try {
      result[key] = JSON.parse(query[key]) as never;
    } catch {
      badQuery(`Invalid JSON in ${key}`);
    }
  }
  if (!isObject(result.nested)) badQuery('nested must be an object');
  return result;
}
export function validateScope(node: Node, scope: Scope, depth = 0): void {
  if (depth > 32) badQuery('scope is too deep');
  for (const [key, selection] of Object.entries(scope)) {
    if (key === '*') continue;
    const child = childrenOf(node)[key];
    if (!Object.hasOwn(childrenOf(node), key) || child.writeOnly) badQuery(`Unknown or inaccessible scope field ${key}`);
    if (selection) {
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
      selection = Object.hasOwn(selection, key) ? (selection[key] ?? ownScope) : ownScope;
      current = child;
    }
  }
}
