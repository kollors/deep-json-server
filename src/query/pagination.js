import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../constants.js';
import { createHttpError } from '../utils.js';

const parsePositiveInteger = (value, name, defaultValue) => {
  if (value == null) {
    return defaultValue;
  }

  if (Array.isArray(value) || !/^[1-9]\d*$/.test(String(value))) {
    throw createHttpError(400, `Параметр ${name} должен быть положительным целым числом`);
  }

  const number = Number(value);

  if (!Number.isSafeInteger(number)) {
    throw createHttpError(400, `Параметр ${name} должен быть положительным целым числом`);
  }

  return number;
};

export const parsePagination = (query, maxPageSize = MAX_PAGE_SIZE) => {
  const page = parsePositiveInteger(query._page, '_page', 1);
  const pageSize = parsePositiveInteger(query._perPage, '_perPage', DEFAULT_PAGE_SIZE);

  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new Error('Максимальный размер страницы должен быть положительным целым числом');
  }

  if (pageSize > maxPageSize) {
    throw createHttpError(400, `Параметр _perPage не должен превышать ${maxPageSize}`);
  }

  return { page, pageSize };
};

export const paginateItems = (items, page, pageSize) => {
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const offset = (page - 1) * pageSize;

  return {
    data: items.slice(offset, offset + pageSize),
    first: 1,
    items: items.length,
    last: pages,
    next: page < pages ? page + 1 : null,
    pages,
    prev: page > 1 ? Math.min(page - 1, pages) : null,
  };
};
