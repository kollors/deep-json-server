import { createHttpError, isEqual, isObject, isSafeKey, toArray } from '../utils.js';

const FIELD_OPERATORS = new Set(['contains', 'endsWith', 'eq', 'every', 'gt', 'gte', 'in', 'lt', 'lte', 'ne', 'none', 'not', 'some', 'startsWith']);
const RESERVED_QUERY_KEYS = new Set(['_embed', '_page', '_perPage', '_sort', '_where']);
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const isFilterEqual = (left, right) => {
  if (isEqual(left, right)) {
    return true;
  }

  if (typeof left === 'number' && typeof right === 'string' && NUMBER_PATTERN.test(right)) {
    // Query parameters are strings, so numeric strings must match stored numbers.
    return left === Number(right);
  }

  return typeof right === 'number' && typeof left === 'string' && NUMBER_PATTERN.test(left) && right === Number(left);
};

const validateLogicalConditions = (operator, value) => {
  if (!Array.isArray(value) || (operator === 'or' && value.length === 0) || value.some((condition) => !isObject(condition))) {
    throw createHttpError(400, `Оператор «${operator}» должен содержать ${operator === 'or' ? 'непустой ' : ''}массив JSON-объектов`);
  }

  return value;
};

const matchesOperator = (field, operator, expectedValue) => {
  switch (operator) {
    case 'contains':
      return typeof field === 'string' ? field.toLowerCase().includes(String(expectedValue).toLowerCase()) : Array.isArray(field) && field.some((value) => isFilterEqual(value, expectedValue));
    case 'endsWith':
      return typeof field === 'string' && field.toLowerCase().endsWith(String(expectedValue).toLowerCase());
    case 'eq':
      return isFilterEqual(field, expectedValue);
    case 'every':
      return Array.isArray(field) && field.every((value) => matchesValue(value, expectedValue));
    case 'gt':
      return field != null && field > expectedValue;
    case 'gte':
      return field != null && field >= expectedValue;
    case 'in': {
      const expectedValues = toArray(expectedValue);

      return Array.isArray(field)
        ? field.some((value) => expectedValues.some((expectedItem) => isFilterEqual(value, expectedItem)))
        : expectedValues.some((expectedItem) => isFilterEqual(field, expectedItem));
    }
    case 'lt':
      return field != null && field < expectedValue;
    case 'lte':
      return field != null && field <= expectedValue;
    case 'ne':
      return !isFilterEqual(field, expectedValue);
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
    return isFilterEqual(field, condition);
  }

  const conditionEntries = Object.entries(condition);
  const operatorEntries = conditionEntries.filter(([operator]) => FIELD_OPERATORS.has(operator));
  const nestedEntries = conditionEntries.filter(([key]) => !FIELD_OPERATORS.has(key));

  if (!operatorEntries.every(([operator, expectedValue]) => matchesOperator(field, operator, expectedValue))) {
    return false;
  }

  return nestedEntries.length === 0 || (isObject(field) && matchesWhere(field, Object.fromEntries(nestedEntries)));
}

export function matchesWhere(value, where) {
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
  if (typeof value !== 'string') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (value === 'null') {
    return null;
  }

  return NUMBER_PATTERN.test(value) && Number.isFinite(Number(value)) ? Number(value) : value;
};

const parseFilterKey = (key) => {
  const colonIndex = key.lastIndexOf(':');

  if (colonIndex !== -1) {
    const path = key.slice(0, colonIndex);
    const operator = key.slice(colonIndex + 1);

    if (!FIELD_OPERATORS.has(operator)) {
      throw createHttpError(400, `Неизвестный оператор «${operator}» в фильтре «${key}»`);
    }

    return { operator, path };
  }

  return { operator: 'eq', path: key };
};

const setWhereOperator = (where, path, operator, value) => {
  const keys = path.split('.');

  if (keys.some((key) => key === '' || !isSafeKey(key))) {
    throw createHttpError(400, `Недопустимый путь фильтра «${path}»`);
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
    let where;

    try {
      where = JSON.parse(rawWhere);
    } catch {
      throw createHttpError(400, 'Параметр _where должен содержать JSON-объект');
    }

    if (!isObject(where)) {
      throw createHttpError(400, 'Параметр _where должен содержать JSON-объект');
    }

    return where;
  }

  const where = {};

  Object.entries(query).forEach(([key, rawValue]) => {
    if (!RESERVED_QUERY_KEYS.has(key)) {
      const filterKey = parseFilterKey(key);

      toArray(rawValue).forEach((value) => {
        setWhereOperator(where, filterKey.path, filterKey.operator, value);
      });
    }
  });

  return where;
};

const validateCondition = (condition, samples, path) => {
  if (!isObject(condition)) {
    return;
  }

  Object.entries(condition).forEach(([key, value]) => {
    if (key === 'and' || key === 'or') {
      validateLogicalConditions(key, value).forEach((nestedWhere) => {
        validateWhere(nestedWhere, samples, path);
      });
      return;
    }

    if (FIELD_OPERATORS.has(key)) {
      if (['every', 'none', 'some'].includes(key)) {
        if (samples.length > 0 && !samples.some(Array.isArray)) {
          throw createHttpError(400, `Оператор «${key}» в фильтре «${path}» можно применить только к массиву`);
        }

        validateCondition(
          value,
          samples.flatMap((sample) => (Array.isArray(sample) ? sample : [])),
          `${path}.${key}`,
        );
      } else if (key === 'not') {
        validateCondition(value, samples, `${path}.not`);
      } else if (['endsWith', 'startsWith'].includes(key) && samples.length > 0 && !samples.some((sample) => typeof sample === 'string')) {
        throw createHttpError(400, `Оператор «${key}» в фильтре «${path}» можно применить только к строке`);
      } else if (key === 'contains' && samples.length > 0 && !samples.some((sample) => typeof sample === 'string' || Array.isArray(sample))) {
        throw createHttpError(400, `Оператор «contains» в фильтре «${path}» можно применить только к строке или массиву`);
      }

      return;
    }

    if (!isSafeKey(key)) {
      throw createHttpError(400, `Недопустимый путь фильтра «${path}.${key}»`);
    }

    const objectSamples = samples.filter(isObject);

    if (samples.length > 0 && objectSamples.length === 0) {
      throw createHttpError(400, `Неизвестный оператор или вложенное поле «${path}.${key}»`);
    }

    const nestedSamples = objectSamples.filter((sample) => Object.hasOwn(sample, key)).map((sample) => sample[key]);

    if (objectSamples.length > 0 && nestedSamples.length === 0) {
      throw createHttpError(400, `Неизвестное поле фильтра «${path}.${key}»`);
    }

    validateCondition(value, nestedSamples, `${path}.${key}`);
  });
};

export const validateWhere = (where, items, path = '') => {
  Object.entries(where).forEach(([key, condition]) => {
    if (key === 'and' || key === 'or') {
      validateLogicalConditions(key, condition).forEach((nestedWhere) => {
        validateWhere(nestedWhere, items, path);
      });
      return;
    }

    if (key === 'not') {
      if (!isObject(condition)) {
        throw createHttpError(400, 'Оператор «not» должен содержать JSON-объект');
      }

      validateWhere(condition, items, path);
      return;
    }

    if (!isSafeKey(key)) {
      throw createHttpError(400, `Недопустимый путь фильтра «${path === '' ? key : `${path}.${key}`}»`);
    }

    const fieldPath = path === '' ? key : `${path}.${key}`;
    const objectItems = items.filter(isObject);
    const samples = objectItems.filter((item) => Object.hasOwn(item, key)).map((item) => item[key]);

    if (objectItems.length > 0 && samples.length === 0) {
      throw createHttpError(400, `Неизвестное поле фильтра «${fieldPath}»`);
    }

    validateCondition(condition, samples, fieldPath);
  });
};
