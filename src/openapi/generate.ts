import { getBoolean, normalizeAddress } from '../core/config-values.js';
import { assertApi, loadModel, type Model, type ModelSchema } from '../core/model.js';
import { loadProjectPackage } from '../core/project-package.js';
import { assertKnownKeys } from '../core/utils.js';
import { buildOpenapiDocument } from './document.js';
import { normalizeOpenapiInfo, type OpenapiDocumentOptions, type OpenapiOptions, projectPackageToOpenapiInfo } from './options.js';
import type { OpenapiDocument } from './types.js';
/** Проверяет параметры экспорта и строит документ из подготовленной модели.
 * @example Модель с коллекцией notes → документ с paths['/notes'].
 */
export function openapiFromModel(model: Model | undefined, options: OpenapiDocumentOptions): OpenapiDocument {
  assertApi(model, 'openapi');
  const auth = getBoolean(options.auth, 'auth');
  const files = getBoolean(options.files, 'files');
  const info = normalizeOpenapiInfo(options.info);
  return createOpenapi({ document: buildOpenapiDocument({ model, auth, files, info, pageSize: options.pageSize, maxPageSize: options.maxPageSize }), host: options.host, port: options.port });
}
/** Загружает описание из объекта или файла и возвращает документ спецификации.
 * @example Корректное описание → Promise<OpenapiDocument> с openapi: '3.0.3'.
 */
export async function generateOpenapi(schema: ModelSchema | string, options: OpenapiOptions): Promise<OpenapiDocument> {
  assertKnownKeys(options, new Set(['auth', 'files', 'host', 'port', 'pageSize', 'maxPageSize', 'packagePath']), 'options');
  const { packagePath, ...documentOptions } = options;
  return openapiFromModel(await loadModel(schema, { auth: options.auth, api: ['openapi'] }), { ...documentOptions, info: projectPackageToOpenapiInfo(await loadProjectPackage(packagePath)) });
}

/** Строит HTTP-адрес, оборачивая IPv6 в квадратные скобки; нулевой порт даёт относительный адрес.
 * @example getServerUrl({ host: '::1', port: 80 }) → 'http://[::1]:80'; { port: 0 } → '/'.
 */
const getServerUrl = (options: { host?: string; port?: number }): string => {
  const { host, port } = normalizeAddress(options);
  if (port === 0) return '/';
  const serverHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${serverHost}:${port}`;
};

/** Копирует документ и задаёт адрес сервера, не меняя исходный объект.
 * @example При host = 'localhost', port = 80 поле servers → [{ url: 'http://localhost:80' }].
 */
export const createOpenapi = ({ document: sourceDocument, host, port }: { document: OpenapiDocument; host?: string; port?: number }): OpenapiDocument => {
  const document = structuredClone(sourceDocument);

  document.servers = [{ url: getServerUrl({ host, port }) }];

  return document;
};
