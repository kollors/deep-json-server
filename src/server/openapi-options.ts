import type { Model } from '../core/model.js';
import type { OpenapiDocumentOptions, OpenapiInfo } from '../openapi/options.js';
import type { NormalizedServerConfig } from './config.js';

/** Собирает параметры OpenAPI из настроек сервера без чтения базы или файлов.
 * @example Конфигурация с files → { files: true, ... }.
 */
export function openapiOptions(config: NormalizedServerConfig, info: OpenapiInfo, model: Model | undefined): OpenapiDocumentOptions {
  return {
    database: model?.entities.some((entity) => entity.api.includes('rest')) ?? true,
    files: config.files !== undefined,
    auth: config.auth !== undefined,
    host: config.server.host,
    port: config.server.port,
    pageSize: config.server.pageSize,
    maxPageSize: config.server.maxPageSize,
    info,
  };
}
