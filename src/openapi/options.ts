import { getObject } from '../core/config-values.js';
export type OpenapiInfo = { title: string; version: string; description?: string };
/** Проверяет метаданные спецификации и возвращает независимую копию.
 * @example normalizeOpenapiInfo({ title: 'API', version: '1' }) → { title: 'API', version: '1' }; description: 42 → ошибка.
 */
export function normalizeOpenapiInfo(value: unknown): OpenapiInfo | undefined {
  const info = getObject(value, 'openapi.info');
  if (!info) return undefined;
  if (typeof info.title !== 'string' || typeof info.version !== 'string' || (info.description !== undefined && typeof info.description !== 'string')) throw new Error('Invalid OpenAPI info');
  return structuredClone(info) as OpenapiInfo;
}

export interface OpenapiOptions {
  auth?: boolean;
  files?: boolean;
  host?: string;
  port?: number;
  pageSize?: number;
  maxPageSize?: number;
  info?: OpenapiInfo;
}
