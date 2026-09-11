import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyServerOptions } from 'fastify';
import type { ModelSchema } from './model.js';
import type { DatabaseData } from './types.js';
import { assertKnownKeys, isObject } from './utils.js';

const CONFIG_KEYS = new Set(['database', 'files', 'openapi', 'graphql', 'server']);
const DATABASE_KEYS = new Set(['data', 'path', 'schema']);
const FILES_KEYS = new Set(['data', 'directory', 'metadata']);
const OPENAPI_KEYS = new Set(['path', 'info', 'enabled', 'endpoint']);
const GRAPHQL_KEYS = new Set(['path', 'enabled', 'endpoint']);
const SERVER_KEYS = new Set(['cors', 'host', 'logger', 'maxFileSize', 'maxPageSize', 'pageSize', 'port']);
let configImportIndex = 0;
const copyInput = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error('Input must contain JSON data or binary file content', { cause: error });
  }
};

export type DatabaseSchema = ModelSchema;
export type DatabaseConfig = { data: DatabaseData; path?: never; schema?: DatabaseSchema | string } | { data?: never; path: string; schema?: DatabaseSchema | string };
export interface MemoryFile {
  content: Uint8Array;
  directory?: string;
  mimeType: string;
  name: string;
}
export type FilesConfig = { data: MemoryFile[]; directory?: never; metadata?: never } | { data?: never; directory: string; metadata: string };
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
  openapi?: OpenapiConfig;
  graphql?: GraphqlConfig;
  server?: ServerConfig;
}
export interface NormalizedServerConfig {
  database: DatabaseConfig;
  files?: FilesConfig;
  openapi: OpenapiConfig;
  graphql: GraphqlConfig;
  server: ServerConfig;
}

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

const resolveConfigPath = (value: string | undefined, directoryPath: string): string | undefined => (value == null ? undefined : resolve(directoryPath, value));

const getPositiveInteger = (value: unknown, path: string): number | undefined => {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Ключ ${path} должен быть положительным целым числом`);
  }

  return value;
};

const normalizeSchema = (schema: unknown, directoryPath: string): DatabaseSchema | string | undefined => {
  if (schema == null) {
    return undefined;
  }

  if (typeof schema === 'string') {
    return resolve(directoryPath, getString(schema, 'config.database.schema', true));
  }

  return getObject(schema, 'config.database.schema', true) as DatabaseSchema;
};

const normalizeDatabase = (value: unknown, directoryPath: string): DatabaseConfig => {
  const database = getObject(value, 'config.database', true);

  assertKnownKeys(database, DATABASE_KEYS, 'config.database');

  const hasData = database.data != null;
  const hasPath = database.path != null;

  if (hasData === hasPath) {
    throw new Error('Укажите ровно один из ключей config.database.path и config.database.data');
  }

  const schema = normalizeSchema(database.schema, directoryPath);

  if (hasData) {
    return { data: copyInput(getObject(database.data, 'config.database.data', true)) as DatabaseData, schema };
  }

  return { path: resolve(directoryPath, getString(database.path, 'config.database.path', true)), schema };
};

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
  if (pageSize !== undefined && pageSize > (maxPageSize ?? 100)) throw new Error('pageSize exceeds maxPageSize');
  const port = server.port;

  if (port != null && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65_535)) {
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
    openapi: { enabled: openapi.enabled as boolean | undefined, endpoint: openapiEndpoint, path: resolveConfigPath(openapiPath, directoryPath), ...(info && { info: info as OpenapiConfig['info'] }) },
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

/** Validates configuration and resolves relative paths. */
export const normalizeServerConfig = (config: DeepJsonServerConfig, directoryPath?: string): NormalizedServerConfig => normalizeConfig(config, directoryPath);

/** Loads an ES module config and resolves paths from its directory. */
export async function readServerConfig(configPath: string): Promise<NormalizedServerConfig> {
  const resolvedConfigPath = resolve(getString(configPath, 'config', true));
  let config: unknown;

  try {
    const configUrl = pathToFileURL(resolvedConfigPath);

    // Bypass the module cache so repeated reads use the latest config.
    configUrl.searchParams.set('deep-json-server-import', String(configImportIndex++));
    config = (await import(configUrl.href)).default;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    throw new Error(`Не удалось загрузить конфигурацию ${resolvedConfigPath}: ${message}`, { cause: error });
  }

  if (!isObject(config)) {
    throw new Error('Конфигурация сервера должна экспортировать JSON-объект через export default');
  }

  return normalizeConfig(config, dirname(resolvedConfigPath));
}
