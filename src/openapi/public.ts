import { assertApi, loadModel, type Model, type ModelSchema } from '../core/model.js';
import { normalizePagination } from '../core/pagination.js';
import { buildOpenapiDocument } from './document.js';
import { createOpenapi } from './index.js';
import type { OpenapiDocument } from './types.js';
export interface OpenapiOptions {
  timestamps?: boolean;
  softDelete?: boolean;
  auth?: boolean;
  files?: boolean;
  host?: string;
  port?: number;
  pageSize?: number;
  maxPageSize?: number;
  info?: { title: string; version: string; description?: string };
}
/** Проверяет параметры экспорта и строит документ из подготовленной модели.
 * @example Модель с коллекцией notes → документ с paths['/notes'].
 */
export function openapiFromModel(model: Model | undefined, options: OpenapiOptions = {}): OpenapiDocument {
  assertApi(model, 'openapi');
  if (options.auth !== undefined && typeof options.auth !== 'boolean') throw new Error('auth must be boolean');
  if (options.files !== undefined && typeof options.files !== 'boolean') throw new Error('files must be boolean');
  if (options.info && (typeof options.info.title !== 'string' || typeof options.info.version !== 'string' || (options.info.description !== undefined && typeof options.info.description !== 'string')))
    throw new Error('Invalid OpenAPI info');
  const pagination = normalizePagination(options);
  return createOpenapi({ document: buildOpenapiDocument({ model, auth: options.auth, files: options.files, info: options.info, ...pagination }), host: options.host, port: options.port });
}
/** Загружает описание из объекта или файла и возвращает документ спецификации.
 * @example Корректное описание → Promise<OpenapiDocument> с openapi: '3.0.3'.
 */
export async function generateOpenapi(schema: ModelSchema | string, options: OpenapiOptions = {}): Promise<OpenapiDocument> {
  return openapiFromModel(await loadModel(schema, options), options);
}
export { writeOpenapi } from './index.js';
