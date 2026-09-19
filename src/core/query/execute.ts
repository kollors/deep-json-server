import type { Node } from '../model.js';
import { readPath } from '../model.js';
import { isRef, type Ref, resolveField } from '../records.js';
import { hasOnlyKeys, isObject } from '../utils.js';
import { compileWhere, type Predicate } from './filter.js';
import { badQuery, type ListOptions, nodeAt } from './options.js';

export interface PreparedList {
  page: number;
  pageSize: number;
  predicate?: Predicate;
  rules: Array<{ direction: 'ASC' | 'DESC'; keys: string[] }>;
}

export interface Page {
  data: Ref[];
  total: number;
}

/** Создаёт представление записи для фильтра, скрывая поля только для записи.
 * @example Запись с writeOnly-полем → объект без этого поля.
 */
function filterView(ref: Ref): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(ref.node.children))
    if (!node.writeOnly && !node.virtual)
      Object.defineProperty(value, name, {
        enumerable: true,
        get: () => {
          const field = resolveField(ref, node, true);
          return isRef(field) ? filterView(field) : Array.isArray(field) ? field.map((item) => (isRef(item) ? filterView(item) : item)) : field;
        },
      });
  return value;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Проверяет аргументы списка и превращает их в готовый план выполнения.
 * @example { pager: { page: 2, pageSize: 5 } } → план с page: 2 и pageSize: 5.
 */
export function prepareList(node: Node, options: ListOptions, pageSize: number, maxPageSize: number): PreparedList {
  const predicate = options.where !== undefined || node.softDelete || node.relation?.softDelete ? compileWhere(node, options.where ?? {}) : undefined;
  if (options.order !== undefined) {
    if (!Array.isArray(options.order)) badQuery('order must be an array');
    for (const rule of options.order) {
      if (!isObject(rule) || !hasOnlyKeys(rule, ['field', 'direction']) || typeof rule.field !== 'string' || !['ASC', 'DESC'].includes(rule.direction)) badQuery('Invalid order rule');
      nodeAt(node, rule.field, true);
    }
  }
  if (options.pager !== undefined && (!isObject(options.pager) || !hasOnlyKeys(options.pager, ['page', 'pageSize']))) badQuery('Invalid pager');
  const page = options.pager?.page ?? 1;
  const size = options.pager?.pageSize ?? pageSize;
  if (
    typeof page !== 'number' ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > maxPageSize ||
    !Number.isSafeInteger((page - 1) * size)
  )
    badQuery(`Invalid pager; pageSize must be 1..${maxPageSize}`);
  return { page, pageSize: size, predicate, rules: (options.order ?? []).map((rule) => ({ direction: rule.direction, keys: rule.field.split('.') })) };
}

/** Фильтрует, сортирует и возвращает страницу, не изменяя исходные записи.
 * @example Три совпадения и page 2 по две записи → третья запись и total 3.
 */
export function executeList(records: Ref[], prepared: PreparedList): Page {
  const { page, pageSize, predicate, rules } = prepared;
  const start = (page - 1) * pageSize;
  const data = predicate ? records.filter((ref) => predicate(filterView(ref))) : records;
  if (!rules.length) return { data: data.slice(start, start + pageSize), total: data.length };
  const ordered = data.map((ref) => ({ ref, keys: rules.map((rule) => readPath(ref.value, rule.keys)[0]) }));
  ordered.sort((leftEntry, rightEntry) => {
    for (let index = 0; index < rules.length; index++) {
      const left = leftEntry.keys[index];
      const right = rightEntry.keys[index];
      const comparison =
        left == null && right == null
          ? 0
          : left == null
            ? 1
            : right == null
              ? -1
              : typeof left === 'number' && typeof right === 'number'
                ? left - right
                : collator.compare(String(left), String(right));
      if (comparison) return rules[index].direction === 'DESC' ? -comparison : comparison;
    }
    return 0;
  });
  return { data: ordered.slice(start, start + pageSize).map(({ ref }) => ref), total: data.length };
}
