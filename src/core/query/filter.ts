import { mentionsDeletedAt } from '../lifecycle/options.js';
import type { Node } from '../model/types.js';
import { isEqual, isObject } from '../utils.js';
import type { QueryBudget } from './budget.js';
import { compareValues } from './compare.js';
import { operatorsFor } from './contract.js';
import { badQuery, childrenOf } from './options.js';

export type Predicate = (value: unknown, budget?: QueryBudget) => boolean;
const comparable = (value: unknown): value is string | number => typeof value === 'string' || typeof value === 'number';
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
      return (field, budget) => !nested(field, budget);
    }
    if (operand === 'element') {
      const nested = condition({ ...node, many: false }, value, depth + 1);
      return (field, budget) => {
        if (!Array.isArray(field)) return false;
        budget?.consume(field.length);
        const values = node.relation?.softDelete && !mentionsDeletedAt(value) ? field.filter((item) => isObject(item) && item.deletedAt == null) : field;
        const test = (item: unknown) => nested(item, budget);
        return operator === 'every' ? values.every(test) : operator === 'none' ? !values.some(test) : values.some(test);
      };
    }
    const values = operand === 'values' ? value : [value];
    if (!Array.isArray(values)) badQuery(`Invalid value for ${operator}`);
    const nullable = ['eq', 'ne', 'in'].includes(operator);
    for (const candidate of values) {
      if (candidate === null && nullable) continue;
      const base = operand === 'text' ? 'string' : node.base;
      if (typeof candidate !== base || (typeof candidate === 'number' && !Number.isFinite(candidate))) badQuery(`Invalid value for ${operator}`);
      if ((operand === 'value' || operand === 'values') && node.enum && !node.enum.some((v) => isEqual(v, candidate))) badQuery(`Invalid enum value for ${operator}`);
    }
    switch (operator) {
      case 'eq':
        return (field) => isEqual(field, value);
      case 'ne':
        return (field) => !isEqual(field, value);
      case 'in':
        return (field, budget) =>
          (Array.isArray(field) ? field : [field]).some((item) =>
            values.some((v) => {
              budget?.consume();
              return isEqual(item, v);
            }),
          );
      case 'contains':
        return (field) => (typeof field === 'string' ? field.toLowerCase().includes(String(value).toLowerCase()) : Array.isArray(field) && field.some((v) => isEqual(v, value)));
      case 'startsWith':
        return (field) => typeof field === 'string' && field.toLowerCase().startsWith(String(value).toLowerCase());
      case 'endsWith':
        return (field) => typeof field === 'string' && field.toLowerCase().endsWith(String(value).toLowerCase());
      case 'gt':
        return (field) => comparable(field) && comparable(value) && compareValues(field, value) > 0;
      case 'gte':
        return (field) => comparable(field) && comparable(value) && compareValues(field, value) >= 0;
      case 'lt':
        return (field) => comparable(field) && comparable(value) && compareValues(field, value) < 0;
      default:
        return (field) => comparable(field) && comparable(value) && compareValues(field, value) <= 0;
    }
  });
  return (value, budget) =>
    predicates.every((predicate) => {
      budget?.consume();
      return predicate(value, budget);
    });
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
      return (field, budget) => {
        const test = (predicate: Predicate) => {
          budget?.consume();
          return predicate(field, budget);
        };
        return key === 'and' ? nested.every(test) : nested.some(test);
      };
    }
    if (key === 'not') {
      const nested = compileWhere(node, value, depth + 1, false);
      return (field, budget) => !nested(field, budget);
    }
    const child = childrenOf(node)[key];
    if (!Object.hasOwn(childrenOf(node), key) || !child || child.writeOnly || child.virtual || child.implicit) badQuery(`Unknown or inaccessible filter field ${key}`);
    if (child.mixed) badQuery(`Field ${key} has inconsistent types; provide an explicit schema`);
    const nested = condition(child, value, depth + 1);
    return (field, budget) => isObject(field) && nested(Object.hasOwn(field, key) ? field[key] : undefined, budget);
  });
  if (defaults && (node.relation?.softDelete || node.softDelete) && !mentionsDeletedAt(input)) predicates.push((value) => isObject(value) && value.deletedAt == null);
  return (value, budget) =>
    isObject(value) &&
    predicates.every((predicate) => {
      budget?.consume();
      return predicate(value, budget);
    });
}
