import { createHttpError, isEqual, isObject, isSafeKey, toArray } from './utils.js';

const FIELD_OPERATORS = new Set(['contains', 'endsWith', 'eq', 'every', 'gt', 'gte', 'in', 'lt', 'lte', 'ne', 'none', 'not', 'some', 'startsWith']);
const RESERVED_QUERY_KEYS = new Set(['_embed', '_page', '_perPage', '_sort', '_where']);

const compareValues = (left, right) => {
  if (Object.is(left, right)) {
    return 0;
  }

  if (left == null) {
    return 1;
  }

  if (right == null) {
    return -1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
};

const getValueByPath = (value, path) => path.split('.').reduce((currentValue, key) => {
  return isSafeKey(key) && currentValue != null ? currentValue[key] : undefined;
}, value);

const matchesOperator = (field, operator, expectedValue) => {
  switch (operator) {
    case 'contains':
      return typeof field === 'string'
        ? field.toLowerCase().includes(String(expectedValue).toLowerCase())
        : Array.isArray(field) && field.some((value) => isEqual(value, expectedValue));
    case 'endsWith':
      return typeof field === 'string' && field.toLowerCase().endsWith(String(expectedValue).toLowerCase());
    case 'eq':
      return isEqual(field, expectedValue);
    case 'every':
      return Array.isArray(field) && field.every((value) => matchesValue(value, expectedValue));
    case 'gt':
      return field != null && field > expectedValue;
    case 'gte':
      return field != null && field >= expectedValue;
    case 'in': {
      const expectedValues = toArray(expectedValue);

      return Array.isArray(field)
        ? field.some((value) => expectedValues.some((expectedItem) => isEqual(value, expectedItem)))
        : expectedValues.some((expectedItem) => isEqual(field, expectedItem));
    }
    case 'lt':
      return field != null && field < expectedValue;
    case 'lte':
      return field != null && field <= expectedValue;
    case 'ne':
      return !isEqual(field, expectedValue);
    case 'none':
      return Array.isArray(field) && !field.some((value) => matchesValue(value, expectedValue));
    case 'not':
      return !matchesValue(field, expectedValue);
    case 'some':
      return Array.isArray(field) && field.some((value) => matchesValue(value, expectedValue));
    case 'startsWith':
      return typeof field === 'string' && field.toLowerCase().startsWith(String(expectedValue).toLowerCase());
    default:
      return false;
  }
};

function matchesValue(field, condition) {
  if (!isObject(condition)) {
    return isEqual(field, condition);
  }

  const conditionEntries = Object.entries(condition);
  const operatorEntries = conditionEntries.filter(([operator]) => FIELD_OPERATORS.has(operator));
  const nestedEntries = conditionEntries.filter(([key]) => !FIELD_OPERATORS.has(key));

  if (!operatorEntries.every(([operator, expectedValue]) => matchesOperator(field, operator, expectedValue))) {
    return false;
  }

  return nestedEntries.length === 0 || isObject(field) && matchesWhere(field, Object.fromEntries(nestedEntries));
}

function matchesWhere(value, where) {
  if (!isObject(value) || !isObject(where)) {
    return false;
  }

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'and') {
      return Array.isArray(condition) && condition.every((nestedWhere) => matchesWhere(value, nestedWhere));
    }

    if (key === 'or') {
      return Array.isArray(condition) && condition.length > 0 && condition.some((nestedWhere) => matchesWhere(value, nestedWhere));
    }

    if (key === 'not') {
      return isObject(condition) && !matchesWhere(value, condition);
    }

    return isSafeKey(key) && matchesValue(value[key], condition);
  });
}

const parsePrimitive = (value) => {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value === 'null' ? null : value;
};

const parseFilterKey = (key) => {
  const colonIndex = key.lastIndexOf(':');

  if (colonIndex !== -1) {
    const path = key.slice(0, colonIndex);
    const operator = key.slice(colonIndex + 1);

    return FIELD_OPERATORS.has(operator) ? { operator, path } : undefined;
  }

  const legacyOperator = key.match(/^(.*)_([a-zA-Z]+)$/);

  if (legacyOperator?.[1] != null && legacyOperator[2] != null && FIELD_OPERATORS.has(legacyOperator[2])) {
    return { operator: legacyOperator[2], path: legacyOperator[1] };
  }

  return { operator: 'eq', path: key };
};

const setWhereOperator = (where, path, operator, value) => {
  const keys = path.split('.').filter(Boolean);

  if (keys.length === 0 || keys.some((key) => !isSafeKey(key))) {
    return;
  }

  const fieldKey = keys.pop();
  let currentValue = where;

  keys.forEach((key) => {
    currentValue[key] = isObject(currentValue[key]) ? currentValue[key] : {};
    currentValue = currentValue[key];
  });

  currentValue[fieldKey] = isObject(currentValue[fieldKey]) ? currentValue[fieldKey] : {};
  currentValue[fieldKey][operator] = operator === 'in' && typeof value === 'string' ? value.split(',').map((item) => parsePrimitive(item.trim())) : parsePrimitive(value);
};

export const parseWhere = (query) => {
  const rawWhere = toArray(query._where).at(-1);

  if (rawWhere != null) {
    try {
      const where = JSON.parse(rawWhere);

      if (!isObject(where)) {
        throw new Error();
      }

      return where;
    } catch {
      throw createHttpError(400, 'Параметр _where должен содержать JSON-объект');
    }
  }

  const where = {};

  Object.entries(query).forEach(([key, rawValue]) => {
    if (RESERVED_QUERY_KEYS.has(key)) {
      return;
    }

    const filterKey = parseFilterKey(key);

    if (filterKey != null) {
      toArray(rawValue).forEach((value) => setWhereOperator(where, filterKey.path, filterKey.operator, value));
    }
  });

  return where;
};

export const paginateItems = (items, page, pageSize) => {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10;
  const pages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.max(1, Math.min(Number.isFinite(page) ? Math.floor(page) : 1, pages));
  const offset = (safePage - 1) * safePageSize;

  return {
    data: items.slice(offset, offset + safePageSize),
    first: 1,
    items: items.length,
    last: pages,
    next: safePage < pages ? safePage + 1 : null,
    pages,
    prev: safePage > 1 ? safePage - 1 : null,
  };
};

export const sortItems = (items, sort) => {
  const sortRules = typeof sort === 'string' ? sort.split(',').filter(Boolean) : [];

  if (sortRules.length === 0) {
    return [...items];
  }

  return [...items].sort((left, right) => {
    for (const sortRule of sortRules) {
      const isDescending = sortRule.startsWith('-');
      const path = isDescending ? sortRule.slice(1) : sortRule;
      const comparison = compareValues(getValueByPath(left, path), getValueByPath(right, path));

      if (comparison !== 0) {
        return isDescending ? -comparison : comparison;
      }
    }

    return 0;
  });
};

export { matchesWhere };
