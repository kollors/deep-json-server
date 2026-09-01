import { createHttpError, isObject, isSafeKey } from '../utils.js';

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

  return typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
};

const getValueByPath = (value, path) => path.split('.').reduce((currentValue, key) => (isObject(currentValue) && isSafeKey(key) ? currentValue[key] : undefined), value);

const parseSortRules = (sort, items) => {
  if (sort == null || sort === '') {
    return [];
  }

  if (typeof sort !== 'string') {
    throw createHttpError(400, 'Параметр _sort должен содержать строку');
  }

  return sort.split(',').map((sortRule) => {
    const isDescending = sortRule.startsWith('-');
    const path = isDescending ? sortRule.slice(1) : sortRule;
    const keys = path.split('.');

    if (keys.some((key) => key === '' || !isSafeKey(key))) {
      throw createHttpError(400, `Недопустимое поле сортировки «${path}»`);
    }

    if (items.length > 0 && !items.some((item) => getValueByPath(item, path) !== undefined)) {
      throw createHttpError(400, `Неизвестное поле сортировки «${path}»`);
    }

    return { isDescending, path };
  });
};

export const sortItems = (items, sort, validationItems = items) => {
  const sortRules = parseSortRules(sort, validationItems);

  return sortRules.length === 0
    ? [...items]
    : [...items].sort((left, right) => {
        for (const { isDescending, path } of sortRules) {
          const comparison = compareValues(getValueByPath(left, path), getValueByPath(right, path));

          if (comparison !== 0) {
            return isDescending ? -comparison : comparison;
          }
        }

        return 0;
      });
};
