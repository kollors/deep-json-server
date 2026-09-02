import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isObject } from './utils.js';

const CONFIG_KEYS = new Set(['database', 'files', 'openapi', 'server']);
const DATABASE_KEYS = new Set(['data', 'path', 'schema']);
const FILES_KEYS = new Set(['data', 'directory', 'metadata']);
const OPENAPI_KEYS = new Set(['path']);
const SERVER_KEYS = new Set(['host', 'logger', 'maxFileSize', 'maxPageSize', 'port']);
let configImportIndex = 0;

/** @typedef {Record<string, Array<Record<string, unknown>>>} DatabaseData */
/** @typedef {Record<string, unknown>} DatabaseSchema */
/** @typedef {{ data: DatabaseData, path?: never, schema?: DatabaseSchema | string } | { data?: never, path: string, schema?: DatabaseSchema | string }} DatabaseConfig */
/** @typedef {{ content: Uint8Array, directory?: string, mimeType: string, name: string }} MemoryFile */
/** @typedef {{ data: MemoryFile[], directory?: never, metadata?: never } | { data?: never, directory: string, metadata: string }} FilesConfig */
/** @typedef {{ path?: string }} OpenapiConfig */
/** @typedef {{ host?: string, logger?: boolean | Record<string, unknown>, maxFileSize?: number, maxPageSize?: number, port?: number }} ServerConfig */
/**
 * @typedef {object} DeepJsonServerConfig
 * @property {DatabaseConfig} database Database source and optional schema.
 * @property {FilesConfig} [files] Binary-file storage.
 * @property {OpenapiConfig} [openapi] Generated OpenAPI file.
 * @property {ServerConfig} [server] Runtime settings.
 */
/** @typedef {{ database: DatabaseConfig, files?: FilesConfig, openapi: OpenapiConfig, server: ServerConfig }} NormalizedServerConfig */

const assertKnownKeys = (value, keys, path) => {
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));

  if (unknownKey != null) {
    throw new Error(`Неизвестный ключ ${path}.${unknownKey}`);
  }
};

const getObject = (value, path, required = false) => {
  if (value == null && !required) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`Ключ ${path} должен быть JSON-объектом`);
  }

  return value;
};

const getString = (value, path, required = false) => {
  if (value == null && !required) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Ключ ${path} должен содержать непустую строку`);
  }

  return value;
};

const resolveConfigPath = (value, directoryPath) => (value == null ? undefined : resolve(directoryPath, value));

const normalizeSchema = (schema, directoryPath) => {
  if (schema == null) {
    return undefined;
  }

  if (typeof schema === 'string') {
    return resolveConfigPath(getString(schema, 'config.database.schema', true), directoryPath);
  }

  return getObject(schema, 'config.database.schema', true);
};

const normalizeDatabase = (value, directoryPath) => {
  const database = getObject(value, 'config.database', true);

  assertKnownKeys(database, DATABASE_KEYS, 'config.database');

  const hasData = database.data != null;
  const hasPath = database.path != null;

  if (hasData === hasPath) {
    throw new Error('Укажите ровно один из ключей config.database.path и config.database.data');
  }

  const schema = normalizeSchema(database.schema, directoryPath);

  if (hasData) {
    return { data: getObject(database.data, 'config.database.data', true), schema };
  }

  return { path: resolveConfigPath(getString(database.path, 'config.database.path', true), directoryPath), schema };
};

const normalizeFiles = (value, directoryPath) => {
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

    return { data: files.data };
  }

  return {
    directory: resolveConfigPath(getString(files.directory, 'config.files.directory', true), directoryPath),
    metadata: resolveConfigPath(getString(files.metadata, 'config.files.metadata', true), directoryPath),
  };
};

/**
 * Validates configuration and resolves relative paths.
 * @param {DeepJsonServerConfig} config Server configuration.
 * @param {string} [directoryPath] Base directory for relative paths.
 * @returns {NormalizedServerConfig} Normalized configuration.
 */
export const normalizeServerConfig = (config, directoryPath = '.') => {
  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна содержать JSON-объект');
  }

  assertKnownKeys(config, CONFIG_KEYS, 'config');

  const database = normalizeDatabase(config.database, directoryPath);
  const files = normalizeFiles(config.files, directoryPath);
  const openapi = getObject(config.openapi, 'config.openapi') ?? {};
  const server = getObject(config.server, 'config.server') ?? {};

  assertKnownKeys(openapi, OPENAPI_KEYS, 'config.openapi');
  assertKnownKeys(server, SERVER_KEYS, 'config.server');

  const openapiPath = getString(openapi.path, 'config.openapi.path');
  const host = getString(server.host, 'config.server.host');

  if (server.port != null && (!Number.isInteger(server.port) || server.port < 0 || server.port > 65_535)) {
    throw new Error('Ключ config.server.port должен быть целым числом от 0 до 65535');
  }

  if (server.maxPageSize != null && (!Number.isInteger(server.maxPageSize) || server.maxPageSize < 1)) {
    throw new Error('Ключ config.server.maxPageSize должен быть положительным целым числом');
  }

  if (server.maxFileSize != null && (!Number.isInteger(server.maxFileSize) || server.maxFileSize < 1)) {
    throw new Error('Ключ config.server.maxFileSize должен быть положительным целым числом');
  }

  if (server.logger != null && typeof server.logger !== 'boolean' && !isObject(server.logger)) {
    throw new Error('Ключ config.server.logger должен содержать boolean или JSON-объект');
  }

  return {
    database,
    files,
    openapi: { path: resolveConfigPath(openapiPath, directoryPath) },
    server: {
      host,
      logger: server.logger,
      maxFileSize: server.maxFileSize,
      maxPageSize: server.maxPageSize,
      port: server.port,
    },
  };
};

/**
 * Loads an ES module config and resolves paths from its directory.
 * @param {string} configPath Configuration module path.
 * @returns {Promise<NormalizedServerConfig>} Normalized configuration.
 */
export async function readServerConfig(configPath) {
  const resolvedConfigPath = resolve(getString(configPath, 'config', true));
  let config;

  try {
    const configUrl = pathToFileURL(resolvedConfigPath);

    // Bypass the module cache so repeated reads use the latest config.
    configUrl.searchParams.set('deep-json-server-import', String(configImportIndex++));
    config = (await import(configUrl.href)).default;
  } catch (error) {
    throw new Error(`Не удалось загрузить конфигурацию ${resolvedConfigPath}: ${error.message}`, { cause: error });
  }

  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна экспортировать JSON-объект через export default');
  }

  return normalizeServerConfig(config, dirname(resolvedConfigPath));
}
