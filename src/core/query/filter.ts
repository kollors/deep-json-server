import { mentionsDeletedAt } from '../lifecycle/options.js';
import type { Node } from '../model.js';
import { isEqual, isObject } from '../utils.js';
import { operatorsFor } from './contract.js';
import { badQuery, childrenOf } from './options.js';

export type Predicate = (value: unknown) => boolean;
const comparable = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';
const equal = (left: unknown, right: unknown) => isEqual(left, right);
/** Компилирует условие поля в предикат, проверяя операторы и их аргументы.
 * @example Для строкового узла condition(node, { contains: 'ан' }, 0)('Анна') → true.
 */
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
      return (field) => {
        if (!Array.isArray(field)) return false;
        const values = node.relation?.softDelete && !mentionsDeletedAt(value) ? field.filter((item) => isObject(item) && item.deletedAt == null) : field;
        return operator === 'every' ? values.every(nested) : operator === 'none' ? !values.some(nested) : values.some(nested);
      };
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
/** Компилирует условия объекта в предикат; учитывает логические операторы и фильтрацию удалённых записей.
 * @example Для числового age: compileWhere(node, { age: { gte: 18 } })({ age: 20 }) → true.
 */
export function compileWhere(node: Node, input: unknown, depth = 0, defaults = true): Predicate {
  if (!isObject(input) || depth > 32) badQuery('where must be an object with depth at most 32');
  const predicates = Object.entries(input).map(([key, value]): Predicate => {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(value) || (key === 'or' && !value.length)) badQuery(`Invalid ${key}`);
      const nested = value.map((item) => compileWhere(node, item, depth + 1, false));
      return (field) => (key === 'and' ? nested.every((p) => p(field)) : nested.some((p) => p(field)));
    }
    if (key === 'not') {
      const nested = compileWhere(node, value, depth + 1, false);
      return (field) => !nested(field);
    }
    const child = childrenOf(node)[key];
    if (!Object.hasOwn(childrenOf(node), key) || child.writeOnly) badQuery(`Unknown or inaccessible filter field ${key}`);
    if (child.mixed) badQuery(`Field ${key} has inconsistent types; provide an explicit schema`);
    const nested = condition(child, value, depth + 1);
    return (field) => isObject(field) && nested(Object.hasOwn(field, key) ? field[key] : undefined);
  });
  if (defaults && (node.relation?.softDelete || node.softDelete) && !mentionsDeletedAt(input)) predicates.push((value) => isObject(value) && value.deletedAt == null);
  return (value) => isObject(value) && predicates.every((predicate) => predicate(value));
}
