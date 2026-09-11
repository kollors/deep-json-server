import type { Node } from '../model.js';
import { isEqual, isObject } from '../utils.js';
import { operatorsFor } from './contract.js';
import { badQuery, childrenOf } from './options.js';

type Predicate = (value: unknown) => boolean;
const comparable = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';
const equal = (left: unknown, right: unknown) => isEqual(left, right);
function condition(node: Node, input: unknown, depth: number): Predicate {
  if (!isObject(input) || depth > 32) badQuery('Field filter must contain operators with depth at most 32');
  if (!node.many && (node.relation || node.base === 'object')) return compileWhere(node, input, depth);
  const operators = operatorsFor(node);
  const predicates = Object.entries(input).map(([operator, value]): Predicate => {
    const operand = operators[operator];
    if (!Object.hasOwn(operators, operator)) badQuery(`Invalid operator ${operator} for ${node.type}`);
    if (operand === 'condition') {
      const nested = condition(node, value, depth + 1);
      return (field) => !nested(field);
    }
    if (operand === 'element') {
      const nested = condition({ ...node, many: false }, value, depth + 1);
      return (field) => Array.isArray(field) && (operator === 'every' ? field.every(nested) : operator === 'none' ? !field.some(nested) : field.some(nested));
    }
    const values = operand === 'values' ? value : [value];
    if (!Array.isArray(values)) badQuery(`Invalid value for ${operator}`);
    const nullable = ['eq', 'ne', 'in'].includes(operator);
    for (const candidate of values) {
      if (candidate === null && nullable) continue;
      const base = operand === 'text' ? 'string' : node.base;
      if (typeof candidate !== base || (typeof candidate === 'number' && !Number.isFinite(candidate))) badQuery(`Invalid value for ${operator}`);
      if ((operand === 'value' || operand === 'values') && node.enum && !node.enum.some((v) => equal(v, candidate))) badQuery(`Invalid enum value for ${operator}`);
    }
    switch (operator) {
      case 'eq':
        return (field) => equal(field, value);
      case 'ne':
        return (field) => !equal(field, value);
      case 'in':
        return (field) => (Array.isArray(field) ? field : [field]).some((item) => values.some((v) => equal(item, v)));
      case 'contains':
        return (field) => (typeof field === 'string' ? field.toLowerCase().includes(String(value).toLowerCase()) : Array.isArray(field) && field.some((v) => equal(v, value)));
      case 'startsWith':
        return (field) => typeof field === 'string' && field.toLowerCase().startsWith(String(value).toLowerCase());
      case 'endsWith':
        return (field) => typeof field === 'string' && field.toLowerCase().endsWith(String(value).toLowerCase());
      case 'gt':
        return (field) => comparable(field) && comparable(value) && field > value;
      case 'gte':
        return (field) => comparable(field) && comparable(value) && field >= value;
      case 'lt':
        return (field) => comparable(field) && comparable(value) && field < value;
      default:
        return (field) => comparable(field) && comparable(value) && field <= value;
    }
  });
  return (value) => predicates.every((predicate) => predicate(value));
}
export function compileWhere(node: Node, input: unknown, depth = 0): Predicate {
  if (!isObject(input) || depth > 32) badQuery('where must be an object with depth at most 32');
  const predicates = Object.entries(input).map(([key, value]): Predicate => {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value) || (key === 'or' && !value.length)) badQuery(`Invalid ${key}`);
      const nested = value.map((item) => compileWhere(node, item, depth + 1));
      return (field) => (key === 'and' ? nested.every((p) => p(field)) : nested.some((p) => p(field)));
    }
    if (key === 'not') {
      const nested = compileWhere(node, value, depth + 1);
      return (field) => !nested(field);
    }
    const child = childrenOf(node)[key];
    if (!Object.hasOwn(childrenOf(node), key) || child.writeOnly) badQuery(`Unknown or inaccessible filter field ${key}`);
    const nested = condition(child, value, depth + 1);
    return (field) => isObject(field) && nested(Object.hasOwn(field, key) ? field[key] : undefined);
  });
  return (value) => isObject(value) && predicates.every((predicate) => predicate(value));
}
