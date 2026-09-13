import type { AuthConfig } from '../auth/contract.js';
import type { DatabaseConfig } from '../core/database.js';
import { recordOptions } from '../core/lifecycle/options.js';
import { errorMessage, isPortNumber } from '../core/utils.js';
import type { FilesConfig, MemoryFile } from '../files/contract.js';

export type { AuthConfig } from '../auth/contract.js';

import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyServerOptions } from 'fastify';
import type { ModelSchema } from '../core/model.js';
import { normalizePagination } from '../core/pagination.js';
import type { DatabaseData } from '../core/types.js';
import { assertKnownKeys, isObject } from '../core/utils.js';

const CONFIG_KEYS = new Set(['database', 'files', 'openapi', 'graphql', 'server', 'auth']);
const DATABASE_KEYS = new Set(['data', 'path', 'schema', 'timestamps', 'softDelete']);
const FILES_KEYS = new Set(['data', 'directory', 'metadata']);
const OPENAPI_KEYS = new Set(['path', 'info', 'enabled', 'endpoint']);
const GRAPHQL_KEYS = new Set(['path', 'enabled', 'endpoint']);
const SERVER_KEYS = new Set(['cors', 'host', 'logger', 'maxFileSize', 'maxPageSize', 'pageSize', 'port']);
let configImportIndex = 0;
/** Глубоко копирует структурированные данные и оборачивает ошибку неподдерживаемого значения.
 * @example copyInput({ a: [1] }) → независимая копия { a: [1] }; функция в значении → ошибка.
 */
const copyInput = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error('Input must contain JSON data or binary file content', { cause: error });
  }
};

export type DatabaseSchema = ModelSchema;
export type { DatabaseConfig } from '../core/database.js';
export type { FilesConfig, MemoryFile } from '../files/contract.js';
export interface OpenapiConfig {
  enabled?: boolean;
  endpoint?: string;
  path?: string;
  info?: { title: string; version: string; description?: string };
}
export interface GraphqlConfig {
  path?: string;
  enabled?: boolean;
  endpoint?: string;
}
export interface ServerConfig {
  cors?: boolean;
  host?: string;
  logger?: FastifyServerOptions['logger'];
  maxFileSize?: number;
  maxPageSize?: number;
  pageSize?: number;
  port?: number;
}
export interface DeepJsonServerConfig {
  database: DatabaseConfig;
  files?: FilesConfig;
  auth?: AuthConfig;
  openapi?: OpenapiConfig;
  graphql?: GraphqlConfig;
  server?: ServerConfig;
}
export interface NormalizedServerConfig {
  database: DatabaseConfig;
  files?: FilesConfig;
  auth?: AuthConfig;
  openapi: OpenapiConfig;
  graphql: GraphqlConfig;
  server: ServerConfig;
}

/** Проверяет объект и обязательность значения; необязательные null и undefined пропускает.
 * @example getObject(undefined, 'data') → undefined; getObject([], 'data', true) → ошибка.
 */
function getObject(value: unknown, path: string, required: true): Record<string, unknown>;
function getObject(value: unknown, path: string, required?: false): Record<string, unknown> | undefined;
function getObject(value: unknown, path: string, required = false): Record<string, unknown> | undefined {
  if (value == null && !required) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`Ключ ${path} должен быть JSON-объектом`);
  }

  return value;
}

/** Проверяет непустую строку, не обрезая её; необязательные null и undefined пропускает.
 * @example getString(' a ', 'name') → ' a '; getString('', 'name') → ошибка.
 */
function getString(value: unknown, path: string, required: true): string;
function getString(value: unknown, path: string, required?: false): string | undefined;
function getString(value: unknown, path: string, required = false): string | undefined {
  if (value == null && !required) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Ключ ${path} должен содержать непустую строку`);
  }

  return value;
}

/** Делает заданный путь абсолютным относительно указанного каталога.
 * @example resolveConfigPath('a.json', '/tmp') → '/tmp/a.json'; undefined → undefined.
 */
const resolveConfigPath = (value: string | undefined, directoryPath: string): string | undefined => (value == null ? undefined : resolve(directoryPath, value));

/** Принимает положительное целое число или отсутствие значения.
 * @example getPositiveInteger(2, 'size') → 2; getPositiveInteger(0, 'size') → ошибка.
 */
const getPositiveInteger = (value: unknown, path: string): number | undefined => {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Ключ ${path} должен быть положительным целым числом`);
  }

  return value;
};

/** Принимает объект описания или разрешает путь к нему относительно каталога.
 * @example normalizeSchema('schema.json', '/tmp') → '/tmp/schema.json'.
 */
const normalizeSchema = (schema: unknown, directoryPath: string): DatabaseSchema | string | undefined => {
  if (schema == null) {
    return undefined;
  }

  if (typeof schema === 'string') {
    return resolve(directoryPath, getString(schema, 'config.database.schema', true));
  }

  return getObject(schema, 'config.database.schema', true) as DatabaseSchema;
};

/** Проверяет выбор между файлом и данными в памяти, разрешает пути и копирует данные.
 * @example { path: 'db.json' } с каталогом /tmp → path: '/tmp/db.json'; одновременно data и path → ошибка.
 */
const normalizeDatabase = (value: unknown, directoryPath: string): DatabaseConfig => {
  const database = getObject(value, 'config.database', true);

  assertKnownKeys(database, DATABASE_KEYS, 'config.database');

  const hasData = database.data != null;
  const hasPath = database.path != null;

  if (hasData === hasPath) {
    throw new Error('Укажите ровно один из ключей config.database.path и config.database.data');
  }

  const schema = normalizeSchema(database.schema, directoryPath);
  recordOptions({ timestamps: database.timestamps as boolean | undefined, softDelete: database.softDelete as boolean | undefined });
  const flags = {
    ...(database.timestamps !== undefined ? { timestamps: database.timestamps as boolean } : {}),
    ...(database.softDelete !== undefined ? { softDelete: database.softDelete as boolean } : {}),
  };

  if (hasData) {
    return { data: copyInput(getObject(database.data, 'config.database.data', true)) as DatabaseData, schema, ...flags };
  }

  return { path: resolve(directoryPath, getString(database.path, 'config.database.path', true)), schema, ...flags };
};

/** Проверяет выбор между файлами в памяти и дисковым хранилищем, разрешает пути.
 * @example normalizeFiles(undefined, '/tmp') → undefined; { data: [] } → { data: [] }.
 */
const normalizeFiles = (value: unknown, directoryPath: string): FilesConfig | undefined => {
  const files = getObject(value, 'config.files');

  if (files == null) {
    return undefined;
  }

  assertKnownKeys(files, FILES_KEYS, 'config.files');

  const hasData = files.data != null;
  const hasDiskStorage = files.directory != null || files.metadata != null;

  if (hasData === hasDiskStorage) {
    throw new Error('Укажите либо config.files.data, либо пару config.files.directory и config.files.metadata');
  }

  if (hasData) {
    if (!Array.isArray(files.data)) {
      throw new Error('Ключ config.files.data должен содержать массив');
    }

    return { data: copyInput(files.data) as MemoryFile[] };
  }

  return {
    directory: resolve(directoryPath, getString(files.directory, 'config.files.directory', true)),
    metadata: resolve(directoryPath, getString(files.metadata, 'config.files.metadata', true)),
  };
};

/** Проверяет источник учётных записей и срок сессии; массив копирует, путь делает абсолютным.
 * @example { users: 'users.json' } с каталогом /tmp → users: '/tmp/users.json'.
 */
const normalizeAuth = (value: unknown, directory: string): AuthConfig | undefined => {
  const auth = getObject(value, 'config.auth');
  if (!auth) return undefined;
  assertKnownKeys(auth, new Set(['users', 'expiresIn']), 'config.auth');
  if (typeof auth.users !== 'string' && !Array.isArray(auth.users)) throw new Error('config.auth.users must be a file path or user array');
  const expiresIn = getPositiveInteger(auth.expiresIn, 'config.auth.expiresIn');
  if (expiresIn !== undefined && expiresIn > 2147483647) throw new Error('config.auth.expiresIn must be at most 2147483647 seconds');
  return {
    users: typeof auth.users === 'string' ? resolve(directory, getString(auth.users, 'config.auth.users', true)) : (copyInput(auth.users) as AuthConfig['users']),
    expiresIn,
  };
};

/** Проверяет секции настроек и возвращает нормализованный объект с абсолютными путями.
 * @example { database: { path: 'db.json' } } с каталогом /tmp → database.path: '/tmp/db.json'.
 */
const normalizeConfig = (config: unknown, directoryPath = '.'): NormalizedServerConfig => {
  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна содержать JSON-объект');
  }

  assertKnownKeys(config, CONFIG_KEYS, 'config');

  const database = normalizeDatabase(config.database, directoryPath);
  const files = normalizeFiles(config.files, directoryPath);
  const openapi = getObject(config.openapi, 'config.openapi') ?? {};
  const graphql = getObject(config.graphql, 'config.graphql') ?? {};
  const server = getObject(config.server, 'config.server') ?? {};

  assertKnownKeys(openapi, OPENAPI_KEYS, 'config.openapi');
  assertKnownKeys(graphql, GRAPHQL_KEYS, 'config.graphql');
  if (openapi.enabled !== undefined && typeof openapi.enabled !== 'boolean') throw new Error('config.openapi.enabled must be boolean');
  const openapiEndpoint = getString(openapi.endpoint, 'config.openapi.endpoint');
  if (openapiEndpoint && !/^\/[A-Za-z][A-Za-z0-9_./-]*$/.test(openapiEndpoint)) throw new Error('Invalid OpenAPI endpoint');
  if (graphql.enabled !== undefined && typeof graphql.enabled !== 'boolean') throw new Error('config.graphql.enabled must be boolean');
  const endpoint = getString(graphql.endpoint, 'config.graphql.endpoint');
  if (endpoint && (!/^\/[A-Za-z][A-Za-z0-9_/-]*$/.test(endpoint) || endpoint === '/')) throw new Error('Invalid GraphQL endpoint');
  const info = getObject(openapi.info, 'config.openapi.info');
  if (info && (typeof info.title !== 'string' || typeof info.version !== 'string')) throw new Error('OpenAPI info requires title and version');
  assertKnownKeys(server, SERVER_KEYS, 'config.server');

  const openapiPath = getString(openapi.path, 'config.openapi.path');
  const cors = server.cors;
  const host = getString(server.host, 'config.server.host');
  const logger = server.logger;
  const maxFileSize = getPositiveInteger(server.maxFileSize, 'config.server.maxFileSize');
  const maxPageSize = getPositiveInteger(server.maxPageSize, 'config.server.maxPageSize');
  const pageSize = getPositiveInteger(server.pageSize, 'config.server.pageSize');
  normalizePagination({ pageSize, maxPageSize });
  const port = server.port;

  if (port != null && !isPortNumber(port)) {
    throw new Error('Ключ config.server.port должен быть целым числом от 0 до 65535');
  }

  if (logger != null && typeof logger !== 'boolean' && !isObject(logger)) {
    throw new Error('Ключ config.server.logger должен содержать boolean или JSON-объект');
  }

  if (cors != null && typeof cors !== 'boolean') {
    throw new Error('Ключ config.server.cors должен содержать boolean');
  }

  return {
    database,
    files,
    auth: normalizeAuth(config.auth, directoryPath),
    openapi: {
      enabled: openapi.enabled as boolean | undefined,
      endpoint: openapiEndpoint,
      path: resolveConfigPath(openapiPath, directoryPath),
      ...(info && { info: copyInput(info) as OpenapiConfig['info'] }),
    },
    graphql: { path: resolveConfigPath(getString(graphql.path, 'config.graphql.path'), directoryPath), enabled: graphql.enabled as boolean | undefined, endpoint },
    server: {
      cors: cors as boolean | undefined,
      host,
      logger: logger as ServerConfig['logger'],
      maxFileSize,
      maxPageSize,
      pageSize,
      port: port as number | undefined,
    },
  };
};

/** Проверяет настройки и разрешает относительные пути, не читая содержимое файлов.
 * @example При directoryPath = '/tmp' путь './db.json' → '/tmp/db.json'.
 */
export const normalizeServerConfig = (config: DeepJsonServerConfig, directoryPath?: string): NormalizedServerConfig => normalizeConfig(config, directoryPath);

/** Загружает default-экспорт ES-модуля, обходя кеш повторного импорта; выполняет код модуля.
 * @example Файл /tmp/config.mjs с export default {} → { config: {}, directory: '/tmp', path: '/tmp/config.mjs' }.
 */
export async function readConfigModule(configPath: string): Promise<{ config: Record<string, unknown>; directory: string; path: string }> {
  const resolvedConfigPath = resolve(getString(configPath, 'config', true));
  let config: unknown;

  try {
    const configUrl = pathToFileURL(resolvedConfigPath);

    // Обходим кеш модуля, чтобы повторное чтение выполняло обновлённый файл.
    configUrl.searchParams.set('deep-json-server-import', String(configImportIndex++));
    config = (await import(configUrl.href)).default;
  } catch (error) {
    const message = errorMessage(error);

    throw new Error(`Не удалось загрузить конфигурацию ${resolvedConfigPath}: ${message}`, { cause: error });
  }

  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна экспортировать JSON-объект через export default');
  }

  return { config, directory: dirname(resolvedConfigPath), path: resolvedConfigPath };
}

const sourcePaths = new WeakMap<NormalizedServerConfig, string>();
/** Возвращает сохранённый путь исходного файла для данного объекта настроек.
 * @example Для объекта без зарегистрированного источника → undefined.
 */
export const configSourcePath = (config: NormalizedServerConfig): string | undefined => sourcePaths.get(config);
/** Нормализует настройки и запоминает путь их источника во внутренней таблице.
 * @example configure(config, '/tmp', '/tmp/config.mjs') → настройки; configSourcePath(result) → '/tmp/config.mjs'.
 */
export function configure(config: unknown, directory: string, sourcePath?: string): NormalizedServerConfig {
  const normalized = normalizeConfig(config, directory);
  if (sourcePath) sourcePaths.set(normalized, sourcePath);
  return normalized;
}
/** Выбирает настройки для указанных форматов экспорта и подставляет пустые данные вместо чтения базы.
 * @example formats = ['graphql'] → настройки генерации GraphQL с database.data = {}.
 */
export function configureGeneration(
  source: Record<string, unknown>,
  formats: string[],
  directory: string,
  sourcePath: string,
  overrides: { host?: string; port?: number; files?: boolean; timestamps?: boolean; softDelete?: boolean },
): NormalizedServerConfig {
  assertKnownKeys(source, CONFIG_KEYS, 'config');
  const database = getObject(source.database, 'config.database', true);
  if (database.schema === undefined) throw new Error('Generation requires an explicit model schema');
  const openapi = formats.includes('openapi');
  const server = openapi ? (getObject(source.server, 'config.server') ?? {}) : {};
  return configure(
    {
      database: { data: {}, schema: database.schema, timestamps: overrides.timestamps ?? database.timestamps, softDelete: overrides.softDelete ?? database.softDelete },
      auth: source.auth != null ? { users: [] } : undefined,
      openapi: openapi ? source.openapi : undefined,
      graphql: formats.includes('graphql') ? source.graphql : undefined,
      files: openapi && (overrides.files || source.files != null) ? { data: [] } : undefined,
      server: openapi
        ? {
            host: overrides.host ?? server.host,
            port: overrides.port ?? server.port,
            pageSize: server.pageSize,
            maxPageSize: server.maxPageSize,
          }
        : {},
    },
    directory,
    sourcePath,
  );
}
