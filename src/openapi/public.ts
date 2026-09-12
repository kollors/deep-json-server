import { assertApi, loadModel, type Model, type ModelSchema } from '../model.js';
import { normalizePagination } from '../pagination.js';
import type { OpenapiDocument } from '../types.js';
import { buildOpenapiDocument } from './document.js';
import { createOpenapi } from './index.js';
export interface OpenapiOptions {
  auth?: boolean;
  files?: boolean;
  host?: string;
  port?: number;
  pageSize?: number;
  maxPageSize?: number;
  info?: { title: string; version: string; description?: string };
}
export function openapiFromModel(model: Model | undefined, options: OpenapiOptions = {}): OpenapiDocument {
  assertApi(model, 'openapi');
  if (options.auth !== undefined && typeof options.auth !== 'boolean') throw new Error('auth must be boolean');
  if (options.files !== undefined && typeof options.files !== 'boolean') throw new Error('files must be boolean');
  if (options.info && (typeof options.info.title !== 'string' || typeof options.info.version !== 'string' || (options.info.description !== undefined && typeof options.info.description !== 'string')))
    throw new Error('Invalid OpenAPI info');
  const pagination = normalizePagination(options);
  return createOpenapi({ document: buildOpenapiDocument({ model, auth: options.auth, files: options.files, info: options.info, ...pagination }), host: options.host, port: options.port });
}
export async function generateOpenapi(schema: ModelSchema | string, options: OpenapiOptions = {}): Promise<OpenapiDocument> {
  return openapiFromModel(await loadModel(schema), options);
}
export { writeOpenapi } from './index.js';
