import { getPositiveInteger } from './config-values.js';
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './constants.js';
/** Подставляет размеры страниц по умолчанию и проверяет положительные безопасные целые числа.
 * @example normalizePagination({ maxPageSize: 5 }) → { pageSize: 5, maxPageSize: 5 }; { pageSize: 0 } → ошибка.
 */
export function normalizePagination(options: { pageSize?: unknown; maxPageSize?: unknown }) {
  const maxPageSize = getPositiveInteger(options.maxPageSize, 'config.server.maxPageSize') ?? DEFAULT_MAX_PAGE_SIZE;
  const pageSize = getPositiveInteger(options.pageSize, 'config.server.pageSize') ?? Math.min(DEFAULT_PAGE_SIZE, maxPageSize);
  if (pageSize > maxPageSize) throw new Error('pageSize exceeds maxPageSize');
  return { pageSize, maxPageSize };
}
