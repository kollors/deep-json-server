import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './constants.js';
/** Подставляет размеры страниц по умолчанию и проверяет положительные безопасные целые числа.
 * @example normalizePagination({ maxPageSize: 5 }) → { pageSize: 5, maxPageSize: 5 }; { pageSize: 0 } → ошибка.
 */
export function normalizePagination(options: { pageSize?: number; maxPageSize?: number }) {
  const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;
  const pageSize = options.pageSize ?? Math.min(DEFAULT_PAGE_SIZE, maxPageSize);
  for (const [key, value] of Object.entries({ pageSize, maxPageSize })) if (!Number.isSafeInteger(value) || value < 1) throw new Error(`config.server.${key} must be a positive safe integer`);
  if (pageSize > maxPageSize) throw new Error('pageSize exceeds maxPageSize');
  return { pageSize, maxPageSize };
}
