import { getObject } from '../core/config-values.js';
import type { ProjectPackage } from '../core/project-package.js';
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

/** Преобразует метаданные проекта в обязательный раздел info OpenAPI. */
export const projectPackageToOpenapiInfo = (value: ProjectPackage): OpenapiInfo => ({
  title: value.name,
  version: value.version,
  ...(value.description === undefined ? {} : { description: value.description }),
});

export interface OpenapiOptions {
  auth?: boolean;
  files?: boolean;
  host?: string;
  port?: number;
  pageSize?: number;
  maxPageSize?: number;
  packagePath: string;
}

export type OpenapiDocumentOptions = Omit<OpenapiOptions, 'packagePath'> & { info: OpenapiInfo };
