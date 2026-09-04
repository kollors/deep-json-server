import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../constants.js';
import type { Query } from '../types.js';
import { createHttpError } from '../utils.js';

export interface Pagination {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  data: T[];
  total: number;
}

const parsePositiveInteger = (value: Query[string], name: string, defaultValue: number): number => {
  if (value == null) {
    return defaultValue;
  }

  const number = Number(value);

  if (Array.isArray(value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(number)) {
    throw createHttpError(400, `Параметр ${name} должен быть положительным целым числом`);
  }

  return number;
};

export const parsePagination = (query: Query, maxPageSize = DEFAULT_MAX_PAGE_SIZE): Pagination => {
  const page = parsePositiveInteger(query._page, '_page', 1);
  const pageSize = parsePositiveInteger(query._perPage, '_perPage', DEFAULT_PAGE_SIZE);

  if (pageSize > maxPageSize) {
    throw createHttpError(400, `Параметр _perPage не должен превышать ${maxPageSize}`);
  }

  return { page, pageSize };
};

export const paginateItems = <T>(items: T[], page: number, pageSize: number): Page<T> => {
  const offset = (page - 1) * pageSize;

  return {
    data: items.slice(offset, offset + pageSize),
    total: items.length,
  };
};
