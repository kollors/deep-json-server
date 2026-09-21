import type { OpenapiDocumentOptions, OpenapiInfo } from '../openapi/options.js';
import type { NormalizedServerConfig } from './config.js';

/** Собирает параметры OpenAPI из настроек сервера без чтения базы или файлов.
 * @example Конфигурация с files → { files: true, ... }.
 */
export function openapiOptions(config: NormalizedServerConfig, info: OpenapiInfo): OpenapiDocumentOptions {
  return {
    files: config.files !== undefined,
    auth: config.auth !== undefined,
    host: config.server.host,
    port: config.server.port,
    pageSize: config.server.pageSize,
    maxPageSize: config.server.maxPageSize,
    info,
  };
}
