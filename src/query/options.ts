import { domainError } from '../errors.js';
import type { Node } from '../model.js';
import { pathParts } from '../model.js';
export interface Order {
  field: string;
  direction: 'ASC' | 'DESC';
}
export interface Pager {
  page?: number;
  pageSize?: number;
}
export interface ListOptions {
  where?: Record<string, unknown>;
  order?: Order[];
  pager?: Pager;
}
export function badQuery(message: string): never {
  throw domainError('INVALID_QUERY', message);
}
export function childrenOf(node: Node): Record<string, Node> {
  return node.relation?.root.children ?? node.children;
}
export function nodeAt(node: Node, path: string, scalarOnly = false): Node {
  let current = node;
  const parts = pathParts(path);
  parts.forEach((part, index) => {
    const child = childrenOf(current)[part];
    if (!child || child.writeOnly) badQuery(`Unknown or inaccessible field ${path}`);
    if (scalarOnly && (child.many || child.relation || (index === parts.length - 1 && child.base === 'object'))) badQuery(`Cannot sort by ${path}`);
    current = child;
  });
  return current;
}
export function sortableFields(node: Node, prefix = ''): string[] {
  return Object.entries(childrenOf(node)).flatMap(([key, child]) => {
    if (child.writeOnly || child.many || child.relation) return [];
    const path = prefix + key;
    return child.base === 'object' ? sortableFields(child, `${path}.`) : [path];
  });
}
