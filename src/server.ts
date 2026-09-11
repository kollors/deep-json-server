import Fastify, { type FastifyInstance, type FastifyListenOptions } from 'fastify';
import { printSchema } from 'graphql';
import { type DeepJsonServerConfig, normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_MAX_PAGE_SIZE, DEFAULT_PORT } from './constants.js';
import { createDatabaseStore } from './database.js';
import { Engine } from './engine.js';
import { DomainError } from './errors.js';
import { resolveFeatures, type ServerFeatures, validateEndpoints } from './features.js';
import { FILE_HEADERS } from './files/contract.js';
import { createFileStore, registerFileRoutes } from './files/index.js';
import { registerGraphqlRoutes } from './graphql/routes.js';
import { buildGraphql } from './graphql.js';
import { assertApi, inferModel, loadModel } from './model.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi } from './openapi/index.js';
import { registerRestRoutes } from './rest/routes.js';
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
  'Access-Control-Allow-Headers': [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', '),
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};
export async function createServer(config: DeepJsonServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  const normalized = normalizeServerConfig(config);
  const enabled = resolveFeatures(normalized, features);
  const explicitModel = await loadModel(normalized.database.schema);
  const { cors = true, logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxPageSize = DEFAULT_MAX_PAGE_SIZE } = normalized.server;
  const pageSize = normalized.server.pageSize ?? Math.min(10, maxPageSize);
  const openapi = async () => {
    assertApi(explicitModel, 'openapi');
    return createOpenapi({
      document: buildOpenapiDocument({ model: explicitModel, files: enabled.files, pageSize, maxPageSize, info: normalized.openapi.info }),
      host: normalized.server.host,
      port: normalized.server.port,
    });
  };
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
        originalListen(optionsOrCallback ?? defaults, callback);
        return;
      }
      return originalListen(optionsOrCallback ?? defaults);
    };
    server.listen = listen as FastifyInstance['listen'];
    server.setErrorHandler((error, request, reply) => {
      const candidate =
        error instanceof DomainError ? ({ INVALID_INPUT: 400, INVALID_QUERY: 400, NOT_FOUND: 404, CONFLICT: 409 } as const)[error.code] : isObject(error) ? error.statusCode : undefined;
      const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
      if (status === 500) request.log.error(error);
      return reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервера' : error instanceof Error ? error.message : String(error) });
    });
    if (cors) {
      server.addHook('onRequest', async (_request, reply) => {
        for (const [key, value] of Object.entries(CORS_HEADERS)) reply.header(key, value);
      });
      server.options('/', async (_request, reply) => reply.code(204).send());
      server.options('/*', async (_request, reply) => reply.code(204).send());
    }
    server.register(async (app) => {
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
      if (enabled.graphql) registerGraphqlRoutes(app, buildGraphql(model, engine), engine, graphqlPath);
      if (enabled.openapi) {
        const document = await openapi();
        app.get(openapiPath, async () => document);
      }
      if (enabled.files) registerFileRoutes(app, { getStore: () => createFileStore(normalized.files!), maxFileSize });
    });
    instance = server;
    return server;
  };
  return {
    fastify: getFastify,
    openapi,
    graphql: async () => {
      assertApi(explicitModel, 'graphql');
      return printSchema(buildGraphql(explicitModel));
    },
  };
}
