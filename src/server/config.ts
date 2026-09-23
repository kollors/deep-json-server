import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyServerOptions } from 'fastify';
import type { AuthConfig } from '../auth/contract.js';
import { getBoolean, getObject, getPositiveInteger, getString, normalizeAddress } from '../core/config-values.js';
import { DEFAULT_MAX_FILE_SIZE } from '../core/constants.js';
import type { DatabaseConfig } from '../core/database.js';
import type { ModelSchema } from '../core/model.js';
import { normalizePagination } from '../core/pagination.js';
import { normalizeProjectPackage, type ProjectPackage } from '../core/project-package.js';
import type { Storage } from '../core/storage.js';
import { assertKnownKeys, errorMessage, isObject } from '../core/utils.js';
import type { FilesConfig } from '../files/contract.js';

export type { AuthConfig } from '../auth/contract.js';
export type { DatabaseConfig } from '../core/database.js';
export type { Storage } from '../core/storage.js';
export type { FilesConfig, MemoryFile } from '../files/contract.js';
export type DatabaseSchema = ModelSchema;
export interface OpenapiConfig {
  endpoint?: string;
  target?: string;
}
export interface GraphqlConfig {
  target?: string;
  endpoint?: string;
}
export type PackageConfig<S extends Storage> = { source: S extends 'file' ? string : ProjectPackage };
export interface ServerConfig {
  cors?: boolean;
  host?: string;
  logger?: FastifyServerOptions['logger'];
  maxFileSize?: number;
  maxPageSize?: number;
  pageSize?: number;
  port?: number;
}
type ApiConfig<S extends Storage> =
  | { openapi?: undefined; graphql?: undefined; package?: PackageConfig<S> }
  | { openapi: OpenapiConfig; graphql?: GraphqlConfig; package: PackageConfig<S> }
  | { openapi?: OpenapiConfig; graphql: GraphqlConfig; package: PackageConfig<S> };
export type DeepJsonServerConfig = {
  [S in Storage]: {
    storage: S;
    database: DatabaseConfig<S>;
    files?: FilesConfig<S>;
    auth?: AuthConfig<S>;
    server?: ServerConfig;
  } & ApiConfig<S>;
}[Storage];
type NormalizedSources = {
  [S in Storage]: { storage: S; database: DatabaseConfig<S>; files?: FilesConfig<S>; auth?: AuthConfig<S>; package?: PackageConfig<S> };
}[Storage];
export type NormalizedServerConfig = NormalizedSources & {
  openapi?: OpenapiConfig & { endpoint: string };
  graphql?: GraphqlConfig & { endpoint: string };
  server: Required<ServerConfig>;
};
const CONFIG_KEYS = new Set(['storage', 'database', 'files', 'auth', 'openapi', 'graphql', 'package', 'server']);
const SERVER_KEYS = new Set(['cors', 'host', 'logger', 'maxFileSize', 'maxPageSize', 'pageSize', 'port']);
let configImportIndex = 0;

/** Проверяет секцию и её допустимые ключи; undefined означает отсутствие секции.
 * @example section({}, 'auth', []) → {}; section(null, 'auth', []) → ошибка.
 */
function section(value: unknown, name: string, keys: string[]): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const object = getObject(value, `config.${name}`, true);
  assertKnownKeys(object, new Set(keys), `config.${name}`);
  return object;
}
/** Копирует начальные данные из памяти после проверки формы контейнера.
 * @example memorySource([], 'auth.source', true) → новый пустой массив; объект вместо массива → ошибка.
 */
function memorySource(value: unknown, name: string, array = false): object {
  if (array ? !Array.isArray(value) : !isObject(value)) throw new Error(`config.${name} must contain ${array ? 'an array' : 'an object'} for memory storage`);
  try {
    return structuredClone(value) as object;
  } catch (error) {
    throw new Error(`config.${name} must contain structured data`, { cause: error });
  }
}
/** Нормализует пути или контейнеры данных, сохраняя связь их типов с режимом хранения.
 * @example storage = 'file', database.source = 'db.json', directory = '/tmp' → source = '/tmp/db.json'.
 */
function normalizeSources(config: Record<string, unknown>, directory: string): NormalizedSources {
  if (config.storage !== 'file' && config.storage !== 'memory') throw new Error("config.storage must be 'file' or 'memory'");
  const database = section(config.database, 'database', ['source', 'schema']);
  if (!database) throw new Error('config.database is required');
  const files = section(config.files, 'files', config.storage === 'file' ? ['source', 'metadata'] : ['source']);
  const auth = section(config.auth, 'auth', ['source', 'expiresIn']);
  const projectPackage = section(config.package, 'package', ['source']);
  const expiresIn = getPositiveInteger(auth?.expiresIn, 'config.auth.expiresIn');
  if (expiresIn !== undefined && expiresIn > 2147483647) throw new Error('config.auth.expiresIn must be at most 2147483647 seconds');
  const path = (value: unknown, name: string) => resolve(directory, getString(value, `config.${name}`, true));
  if (config.storage === 'file') {
    const filesSource = files ? path(files.source, 'files.source') : undefined;
    return {
      storage: 'file',
      database: { source: path(database.source, 'database.source'), ...(database.schema === undefined ? {} : { schema: path(database.schema, 'database.schema') }) },
      files: files && filesSource ? { source: filesSource, metadata: files.metadata === undefined ? resolve(filesSource, '.files.json') : path(files.metadata, 'files.metadata') } : undefined,
      auth: auth ? { source: path(auth.source, 'auth.source'), expiresIn } : undefined,
      package: projectPackage ? { source: path(projectPackage.source, 'package.source') } : undefined,
    };
  }
  // Содержимое контейнеров проверяют загрузчики модели и хранилищ перед использованием.
  return {
    storage: 'memory',
    database: {
      source: memorySource(database.source, 'database.source') as DatabaseConfig<'memory'>['source'],
      ...(database.schema === undefined ? {} : { schema: memorySource(database.schema, 'database.schema') as ModelSchema }),
    },
    files: files ? { source: memorySource(files.source, 'files.source', true) as FilesConfig<'memory'>['source'] } : undefined,
    auth: auth ? { source: memorySource(auth.source, 'auth.source', true) as AuthConfig<'memory'>['source'], expiresIn } : undefined,
    package: projectPackage ? { source: normalizeProjectPackage(memorySource(projectPackage.source, 'package.source'), 'config.package.source') } : undefined,
  };
}
/** Проверяет секции настроек и возвращает независимые данные с абсолютными путями.
 * @example { storage: 'file', database: { source: 'db.json' } } → абсолютный database.source.
 */
function normalizeConfig(value: unknown, directory = '.'): NormalizedServerConfig {
  const config = getObject(value, 'config', true);
  assertKnownKeys(config, CONFIG_KEYS, 'config');
  const sources = normalizeSources(config, directory);
  const openapi = section(config.openapi, 'openapi', ['target', 'endpoint']);
  const graphql = section(config.graphql, 'graphql', ['target', 'endpoint']);
  if ((openapi || graphql) && sources.database.schema === undefined) throw new Error('GraphQL and OpenAPI require an explicit model schema');
  if ((openapi || graphql) && !sources.package) throw new Error('GraphQL and OpenAPI require config.package');
  const exportPath = (value: unknown, name: string) => (value === undefined ? undefined : resolve(directory, getString(value, name, true)));
  const openapiEndpoint = getString(openapi?.endpoint, 'config.openapi.endpoint') ?? '/openapi.json';
  const graphqlEndpoint = getString(graphql?.endpoint, 'config.graphql.endpoint') ?? '/graphql';
  if (!/^\/[A-Za-z][A-Za-z0-9_./-]*$/.test(openapiEndpoint)) throw new Error('Invalid OpenAPI endpoint');
  if (!/^\/[A-Za-z][A-Za-z0-9_/-]*$/.test(graphqlEndpoint)) throw new Error('Invalid GraphQL endpoint');
  const server = getObject(config.server, 'config.server') ?? {};
  assertKnownKeys(server, SERVER_KEYS, 'config.server');
  const logger = server.logger;
  if (logger != null && typeof logger !== 'boolean' && !isObject(logger)) throw new Error('config.server.logger must be boolean or an object');
  return {
    ...sources,
    openapi: openapi ? { endpoint: openapiEndpoint, target: exportPath(openapi.target, 'config.openapi.target') } : undefined,
    graphql: graphql ? { endpoint: graphqlEndpoint, target: exportPath(graphql.target, 'config.graphql.target') } : undefined,
    server: {
      ...normalizeAddress(server),
      ...normalizePagination(server),
      cors: getBoolean(server.cors, 'config.server.cors') ?? true,
      logger: (logger ?? true) as Required<ServerConfig>['logger'],
      maxFileSize: getPositiveInteger(server.maxFileSize, 'config.server.maxFileSize') ?? DEFAULT_MAX_FILE_SIZE,
    },
  };
}
/** Нормализует объект конфигурации без чтения содержимого файлов.
 * @example Путь './db.json' с directory = '/tmp' → '/tmp/db.json'.
 */
export const normalizeServerConfig = (config: DeepJsonServerConfig, directory?: string): NormalizedServerConfig => normalizeConfig(config, directory);

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

    throw new Error(`Cannot load configuration ${resolvedConfigPath}: ${message}`, { cause: error });
  }

  if (!isObject(config)) {
    throw new Error('Server configuration must export a JSON object as default');
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
