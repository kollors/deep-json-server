import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isObject } from './utils.js';

const CONFIG_KEYS = new Set(['database', 'files', 'openapi', 'server']);
const DATABASE_KEYS = new Set(['path', 'schema']);
const FILES_KEYS = new Set(['directory', 'metadata']);
const OPENAPI_KEYS = new Set(['path']);
const SERVER_KEYS = new Set(['host', 'port']);
let configImportIndex = 0;

const assertKnownKeys = (value, keys, path) => {
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));

  if (unknownKey != null) {
    throw new Error(`Неизвестный ключ ${path}.${unknownKey}`);
  }
};

const getObject = (value, path) => {
  if (value == null) {
    return {};
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

export async function readServerConfig(configPath) {
  const resolvedConfigPath = resolve(getString(configPath, 'config', true));
  let config;

  try {
    const configUrl = pathToFileURL(resolvedConfigPath);

    configUrl.searchParams.set('deep-json-server-import', String(configImportIndex++));
    config = (await import(configUrl.href)).default;
  } catch (error) {
    throw new Error(`Не удалось загрузить конфигурацию ${resolvedConfigPath}: ${error.message}`, { cause: error });
  }

  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна экспортировать JSON-объект через export default');
  }

  assertKnownKeys(config, CONFIG_KEYS, 'config');

  const database = getObject(config.database, 'config.database');
  const files = getObject(config.files, 'config.files');
  const openapi = getObject(config.openapi, 'config.openapi');
  const server = getObject(config.server, 'config.server');

  assertKnownKeys(database, DATABASE_KEYS, 'config.database');
  assertKnownKeys(files, FILES_KEYS, 'config.files');
  assertKnownKeys(openapi, OPENAPI_KEYS, 'config.openapi');
  assertKnownKeys(server, SERVER_KEYS, 'config.server');

  const directoryPath = dirname(resolvedConfigPath);
  const databasePath = getString(database.path, 'config.database.path', true);
  const schemaPath = getString(database.schema, 'config.database.schema');
  const openapiPath = getString(openapi.path, 'config.openapi.path');
  const filesDirectory = getString(files.directory, 'config.files.directory');
  const filesMetadata = getString(files.metadata, 'config.files.metadata');
  const host = getString(server.host, 'config.server.host');

  if (server.port != null && (!Number.isInteger(server.port) || server.port < 0 || server.port > 65_535)) {
    throw new Error('Ключ config.server.port должен быть целым числом от 0 до 65535');
  }

  return {
    configPath: resolvedConfigPath,
    databasePath: resolveConfigPath(databasePath, directoryPath),
    filesDirectoryPath: resolveConfigPath(filesDirectory, directoryPath),
    filesMetadataPath: resolveConfigPath(filesMetadata, directoryPath),
    host,
    openapiPath: resolveConfigPath(openapiPath, directoryPath),
    port: server.port,
    schemaPath: resolveConfigPath(schemaPath, directoryPath),
  };
}
