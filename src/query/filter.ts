import { isEqual, isObject, isSafeKey, toArray } from '../utils.js';

const FIELD_OPERATOR_NAMES = ['contains', 'endsWith', 'eq', 'every', 'gt', 'gte', 'in', 'lt', 'lte', 'ne', 'none', 'not', 'some', 'startsWith'] as const;

type FieldOperator = (typeof FIELD_OPERATOR_NAMES)[number];

const FIELD_OPERATORS = new Set<string>(FIELD_OPERATOR_NAMES);
const NUMBER_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

const isFieldOperator = (value: string): value is FieldOperator => FIELD_OPERATORS.has(value);

const isFilterEqual = (left: unknown, right: unknown): boolean => {
  if (isEqual(left, right)) {
    return true;
  }

  if (typeof left === 'number' && typeof right === 'string' && NUMBER_PATTERN.test(right)) {
    // Query parameters are strings, so numeric strings must match stored numbers.
    return left === Number(right);
  }

  return typeof right === 'number' && typeof left === 'string' && NUMBER_PATTERN.test(left) && right === Number(left);
};

const isComparable = (value: unknown): value is number | string => typeof value === 'number' || typeof value === 'string';

const matchesOperator = (field: unknown, operator: FieldOperator, expectedValue: unknown): boolean => {
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
      return isComparable(field) && isComparable(expectedValue) && field > expectedValue;
    case 'gte':
      return isComparable(field) && isComparable(expectedValue) && field >= expectedValue;
    case 'in': {
      const expectedValues = toArray(expectedValue);

      return Array.isArray(field)
        ? field.some((value) => expectedValues.some((expectedItem) => isFilterEqual(value, expectedItem)))
        : expectedValues.some((expectedItem) => isFilterEqual(field, expectedItem));
    }
    case 'lt':
      return isComparable(field) && isComparable(expectedValue) && field < expectedValue;
    case 'lte':
      return isComparable(field) && isComparable(expectedValue) && field <= expectedValue;
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

function matchesValue(field: unknown, condition: unknown): boolean {
  if (!isObject(condition)) {
    return isFilterEqual(field, condition);
  }

  const conditionEntries = Object.entries(condition);
  const operatorEntries = conditionEntries.filter((entry): entry is [FieldOperator, unknown] => isFieldOperator(entry[0]));
  const nestedEntries = conditionEntries.filter(([key]) => !isFieldOperator(key));

  if (!operatorEntries.every(([operator, expectedValue]) => matchesOperator(field, operator, expectedValue))) {
    return false;
  }

  return nestedEntries.length === 0 || (isObject(field) && matchesWhere(field, Object.fromEntries(nestedEntries)));
}

export function matchesWhere(value: unknown, where: unknown): boolean {
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
