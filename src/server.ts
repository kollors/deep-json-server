import type { FastifyInstance, FastifyListenOptions } from 'fastify';
import { configSourcePath, type DeepJsonServerConfig, type NormalizedServerConfig, normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_PORT } from './constants.js';
import { DomainError } from './errors.js';
import { resolveFeatures, type ServerFeatures, validateEndpoints } from './features.js';
import { domainStatus } from './http/errors.js';
import { normalizePagination } from './pagination.js';
import { inputPaths } from './paths.js';
import type { OpenapiDocument } from './types.js';
import { isObject } from './utils.js';
export interface ServerFacade {
  fastify(): FastifyInstance;
  openapi(): Promise<OpenapiDocument>;
  graphql(): Promise<string>;
}
export type { ServerFeatures } from './features.js';

type ListenCallback = (error: Error | null, address: string) => void;
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};
export async function createServer(config: DeepJsonServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  return createConfiguredServer(normalizeServerConfig(config), features);
}
export async function createConfiguredServer(normalized: NormalizedServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  const enabled = resolveFeatures(normalized, features);
  const { loadModel, inferModel } = await import('./model.js');
  const explicitModel = await loadModel(normalized.database.schema);
  const { default: Fastify } = await import('fastify');
  const corsHeaders = { ...CORS_HEADERS };
  if (enabled.files) {
    const { FILE_HEADERS } = await import('./files/http.js');
    corsHeaders['Access-Control-Allow-Headers'] = [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', ');
  }
  const { cors = true, logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE } = normalized.server;
  const { pageSize, maxPageSize } = normalizePagination(normalized.server);
  const openapi = async () =>
    (await import('./openapi/public.js')).openapiFromModel(explicitModel, {
      files: enabled.files,
      pageSize,
      maxPageSize,
      info: normalized.openapi.info,
      host: normalized.server.host,
      port: normalized.server.port,
    });
  let instance: FastifyInstance | undefined;
  const getFastify = (): FastifyInstance => {
    if (instance) return instance;
    const server = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }, logger });
    const originalListen = server.listen.bind(server);
    const defaults = { host: normalized.server.host ?? DEFAULT_HOST, port: normalized.server.port ?? DEFAULT_PORT };
    const listen = (optionsOrCallback?: FastifyListenOptions | ListenCallback, callback?: ListenCallback): Promise<string> | undefined => {
      if (typeof optionsOrCallback === 'function') {
        originalListen(defaults, optionsOrCallback);
        return;
      }
      if (callback) {
        originalListen({ ...defaults, ...optionsOrCallback }, callback);
        return;
      }
      return originalListen({ ...defaults, ...optionsOrCallback });
    };
    server.listen = listen as FastifyInstance['listen'];
    server.setErrorHandler((error, request, reply) => {
      const candidate = error instanceof DomainError ? domainStatus[error.code] : isObject(error) ? error.statusCode : undefined;
      const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
      if (status === 500) request.log.error(error);
      return reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервера' : error instanceof Error ? error.message : String(error) });
    });
    if (cors) {
      server.addHook('onRequest', async (_request, reply) => {
        for (const [key, value] of Object.entries(corsHeaders)) reply.header(key, value);
      });
      server.options('/', async (_request, reply) => reply.code(204).send());
      server.options('/*', async (_request, reply) => reply.code(204).send());
    }
    server.register(async (app) => {
      const [{ createDatabaseStore }, { Engine }, { registerRestRoutes }] = await Promise.all([import('./database.js'), import('./engine.js'), import('./rest/routes.js')]);
      const keys = explicitModel ? new Map(explicitModel.entities.map((e) => [e.collection, e.primary])) : undefined;
      const store = await createDatabaseStore(normalized.database, keys);
      const model = explicitModel ?? inferModel(store.database.data);
      const engine = new Engine(store, model, pageSize, maxPageSize);
      engine.validateData(store.database.data);
      const graphqlPath = normalized.graphql.endpoint ?? '/graphql';
      const openapiPath = normalized.openapi.endpoint ?? '/openapi.json';
      validateEndpoints(
        model.entities.map((entity) => entity.collection),
        [...(enabled.graphql ? [graphqlPath] : []), ...(enabled.openapi ? [openapiPath] : [])],
      );
      registerRestRoutes(app, engine);
      if (enabled.graphql) {
        const [{ registerGraphqlRoutes }, { buildGraphql }] = await Promise.all([import('./graphql/routes.js'), import('./graphql.js')]);
        registerGraphqlRoutes(app, buildGraphql(model), engine, graphqlPath);
      }
      if (enabled.openapi) {
        const document = await openapi();
        document.servers = [{ url: '/' }];
        app.get(openapiPath, async () => document);
      }
      const files = normalized.files;
      if (enabled.files && files) {
        const { createFileStore, registerFileRoutes } = await import('./files/index.js');
        const protectedPaths = inputPaths({ database: normalized.database }, '.', configSourcePath(normalized));
        registerFileRoutes(app, { getStore: () => createFileStore(files, protectedPaths), maxFileSize });
      }
    });
    instance = server;
    return server;
  };
  return {
    fastify: getFastify,
    openapi,
    graphql: async () => {
      return (await import('./graphql/public.js')).graphqlFromModel(explicitModel);
    },
  };
}
