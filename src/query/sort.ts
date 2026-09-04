import { createHttpError, isObject, isSafeKey } from '../utils.js';

interface SortRule {
  isDescending: boolean;
  path: string;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const compareValues = (left: unknown, right: unknown): number => {
  if (Object.is(left, right)) {
    return 0;
  }

  if (left == null) {
    return 1;
  }

  if (right == null) {
    return -1;
  }

  return typeof left === 'number' && typeof right === 'number' ? left - right : collator.compare(String(left), String(right));
};

const getValueByPath = (value: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((currentValue, key) => (isObject(currentValue) && isSafeKey(key) ? currentValue[key] : undefined), value);

const parseSortRules = (sort: unknown, items: unknown[]): SortRule[] => {
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

    const samples = items.map((item) => getValueByPath(item, path)).filter((value) => value !== undefined);

    if (items.length > 0 && samples.length === 0) {
      throw createHttpError(400, `Неизвестное поле сортировки «${path}»`);
    }

    if (samples.some((value) => isObject(value) || Array.isArray(value))) {
      throw createHttpError(400, `Поле сортировки «${path}» должно содержать примитивные значения`);
    }

    return { isDescending, path };
  });
};

export const sortItems = <T>(items: T[], sort: unknown, validationItems: unknown[] = items): T[] => {
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
