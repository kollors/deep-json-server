import type { FastifyInstance } from 'fastify';
import { loadProjectPackage } from '../core/project-package.js';
import { type OpenapiInfo, projectPackageToOpenapiInfo } from '../openapi/options.js';
import type { OpenapiDocument } from '../openapi/types.js';
import { registerConfiguredModules } from './bootstrap.js';
import { type DeepJsonServerConfig, type NormalizedServerConfig, normalizeServerConfig } from './config.js';
import { createHttpServer } from './http.js';
import { configuredModel } from './model.js';
import { openapiOptions } from './openapi-options.js';
export interface ServerFacade {
  fastify(): FastifyInstance;
  openapi(): Promise<OpenapiDocument>;
  graphql(): Promise<string>;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};
/** Проверяет настройки и создаёт интерфейс запуска и генерации схем; сетевой порт ещё не открывает.
 * @example await createServer({ storage: 'memory', database: { source: { notes: [] } } }) → объект с fastify(), openapi(), graphql().
 */
export async function createServer(...args: [DeepJsonServerConfig]): Promise<ServerFacade> {
  if (args.length !== 1) throw new Error('createServer accepts only a configuration object');
  return createConfiguredServer(normalizeServerConfig(args[0]));
}
/** Собирает сервер из нормализованных настроек; хранилища открываются при инициализации HTTP-экземпляра.
 * @example Нормализованные настройки → Promise<ServerFacade>; listen() затем открывает сетевой порт.
 */
export async function createConfiguredServer(normalized: NormalizedServerConfig, openapiInfo?: OpenapiInfo): Promise<ServerFacade> {
  const packageInfo = openapiInfo ?? (normalized.package ? projectPackageToOpenapiInfo(await loadProjectPackage(normalized.package.source)) : undefined);
  const enabled = { auth: normalized.auth !== undefined, files: normalized.files !== undefined };
  const explicitModel = await configuredModel(normalized);
  const { default: Fastify } = await import('fastify');
  const corsHeaders = { ...CORS_HEADERS };
  if (enabled.files) {
    const { FILE_HEADERS } = await import('../files/http.js');
    corsHeaders['Access-Control-Allow-Headers'] = [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', ');
  }
  if (enabled.auth) corsHeaders['Access-Control-Allow-Headers'] += ', Authorization';
  const { cors, logger } = normalized.server;
  const openapi = async () => {
    if (!normalized.openapi) throw new Error('OpenAPI is not configured');
    if (!packageInfo) throw new Error('OpenAPI package metadata is not configured');
    return (await import('../openapi/generate.js')).openapiFromModel(explicitModel, openapiOptions(normalized, packageInfo));
  };
  let instance: FastifyInstance | undefined;
  const getFastify = (): FastifyInstance => {
    if (instance) return instance;
    const server = createHttpServer({ create: Fastify, host: normalized.server.host, port: normalized.server.port, logger, cors, corsHeaders });
    server.register(async (app) => registerConfiguredModules(app, normalized, explicitModel, openapi));
    instance = server;
    return server;
  };
  return {
    fastify: getFastify,
    openapi,
    graphql: async () => {
      if (!normalized.graphql) throw new Error('GraphQL is not configured');
      return (await import('../graphql/generate.js')).graphqlFromModel(explicitModel);
    },
  };
}
