import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyListenOptions } from 'fastify';
import { type GraphQLSchema, printSchema } from 'graphql';
import mercurius from 'mercurius';
import { type DeepJsonServerConfig, normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_MAX_PAGE_SIZE, DEFAULT_PORT } from './constants.js';
import { createDatabaseStore } from './database.js';
import { Engine, makeContext } from './engine.js';
import { FILE_HEADERS } from './files/contract.js';
import { createFileStore, registerFileRoutes } from './files/index.js';
import { buildGraphql } from './graphql.js';
import { assertApi, inferModel, loadModel } from './model.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi, writeOpenapi } from './openapi/index.js';
import { parseRestOptions } from './query/options.js';
import type { OpenapiDocument } from './types.js';
import { createHttpError, isObject } from './utils.js';
export interface ServerFacade {
  fastify(): FastifyInstance;
  openapi(): Promise<OpenapiDocument>;
  graphql(): Promise<string>;
}
export interface ServerFeatures {
  files?: boolean;
  graphql?: boolean;
}
type ListenCallback = (error: Error | null, address: string) => void;
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', '),
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};
/** Creates REST, GraphQL and independent schema exporters from a shared model. */
export async function createServer(config: DeepJsonServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  if (!isObject(features) || Object.entries(features).some(([key, value]) => !['files', 'graphql'].includes(key) || typeof value !== 'boolean'))
    throw new Error('features supports boolean files and graphql keys');
  const normalizedConfig = normalizeServerConfig(config);
  const explicitModel = await loadModel(normalizedConfig.database.schema);
  const keys = explicitModel ? new Map(explicitModel.entities.map((e) => [e.collection, e.primary])) : undefined;
  const store = await createDatabaseStore(normalizedConfig.database, keys);
  const model = explicitModel ?? inferModel(store.database.data);
  const { cors = true, logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxPageSize = DEFAULT_MAX_PAGE_SIZE } = normalizedConfig.server;
  const pageSize = normalizedConfig.server.pageSize ?? Math.min(10, maxPageSize);
  const engine = new Engine(store, model, pageSize, maxPageSize);
  engine.validateData(store.database.data);
  const filesEnabled = features.files === undefined ? normalizedConfig.files != null : features.files === true;
  const graphqlEnabled = features.graphql ?? normalizedConfig.graphql.enabled ?? false;
  if (filesEnabled && !normalizedConfig.files) throw new Error('Для файловых маршрутов укажите секцию config.files');
  let fileStorePromise: ReturnType<typeof createFileStore> | undefined;
  const getFileStore = () => (fileStorePromise ??= createFileStore(normalizedConfig.files as NonNullable<typeof normalizedConfig.files>));
  if (filesEnabled && normalizedConfig.files?.data) await getFileStore();
  let fastifyInstance: FastifyInstance | undefined;
  let graphqlSchema: GraphQLSchema | undefined;
  const getGraphql = () => (graphqlSchema ??= buildGraphql(model, engine));
  if (graphqlEnabled) getGraphql();
  const getFastify = (): FastifyInstance => {
    if (fastifyInstance) return fastifyInstance;
    const fastify = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }, logger });
    const originalListen = fastify.listen.bind(fastify);

    // Calling fastify().listen() without arguments uses config defaults.
    const defaultListenOptions = { host: normalizedConfig.server.host ?? DEFAULT_HOST, port: normalizedConfig.server.port ?? DEFAULT_PORT };
    const listenWithDefaults = (optionsOrCallback?: FastifyListenOptions | ListenCallback, callback?: ListenCallback): Promise<string> | undefined => {
      if (typeof optionsOrCallback === 'function') {
        originalListen(defaultListenOptions, optionsOrCallback);
        return undefined;
      }

      const options = optionsOrCallback ?? defaultListenOptions;

      if (callback != null) {
        originalListen(options, callback);
        return undefined;
      }

      return originalListen(options);
    };

    fastify.listen = listenWithDefaults as FastifyInstance['listen'];

    if (cors) {
      fastify.addHook('onRequest', async (_request, reply) => {
        for (const [header, value] of Object.entries(CORS_HEADERS)) reply.header(header, value);
      });
      fastify.options('/', async (_request, reply) => reply.code(204).send());
      fastify.options('/*', async (_request, reply) => reply.code(204).send());
    }
    const resources = model.entities.map((e) => e.collection);
    fastify.get('/', async () => ({ resources }));
    for (const initialEntity of model.entities) {
      const collection = initialEntity.collection;
      const path = `/${collection}`;
      const itemPath = `${path}/:${initialEntity.primary}`;
      if (graphqlEnabled && path === (normalizedConfig.graphql.endpoint ?? '/graphql')) throw new Error('GraphQL endpoint conflicts with collection');
      fastify.get(path, async (request) => {
        const context = await engine.context();
        const entity = engine.entity(collection);
        const options = parseRestOptions(request.query, true);
        engine.validateRest(entity, options);
        const page = engine.list(engine.records(context, entity), entity.root, options);
        return { data: page.data.map((ref) => engine.project(ref, options.scope, options.nested)), total: page.total };
      });
      fastify.get(itemPath, async (request) => {
        const context = await engine.context();
        const entity = engine.entity(collection);
        const options = parseRestOptions(request.query, false);
        engine.validateRest(entity, options);
        const ref = engine.find(context, entity, (request.params as Record<string, string>)[entity.primary]);
        if (!ref) throw createHttpError(404, 'Record not found');
        return engine.project(ref, options.scope, options.nested);
      });
      for (const [method, mode] of [
        ['POST', 'create'],
        ['PUT', 'replace'],
        ['PATCH', 'update'],
        ['DELETE', 'delete'],
      ] as const) {
        fastify.route({
          method,
          url: mode === 'create' ? path : itemPath,
          handler: async (request, reply) => {
            const entity = engine.entity(collection);
            const options = parseRestOptions(request.query, false);
            engine.validateRest(entity, options);
            const ref = await engine.mutate(entity, mode, (request.params as Record<string, string>)[entity.primary], request.body);
            // Re-infer schemaless response fields after successful writes.
            if (!model.explicit) {
              const refreshed = inferModel(ref.context.data);
              ref.context = makeContext(ref.context.data, refreshed);
              ref.entity = refreshed.byCollection.get(collection) as typeof entity;
              ref.node = ref.entity.root;
            }
            return reply.code(mode === 'create' ? 201 : 200).send(engine.project(ref, options.scope, options.nested));
          },
        });
      }
    }
    if (graphqlEnabled)
      fastify.register(mercurius, { schema: getGraphql(), path: normalizedConfig.graphql.endpoint ?? '/graphql', queryDepth: 32, context: async () => ({ snapshot: await engine.context() }) });
    if (filesEnabled) registerFileRoutes(fastify, { getStore: getFileStore, maxFileSize });
    fastify.setErrorHandler((error, request, reply) => {
      const candidate = isObject(error) ? error.statusCode : undefined;
      const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
      if (status === 500) request.log.error(error);
      return reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервера' : error instanceof Error ? error.message : String(error) });
    });
    fastifyInstance = fastify;
    return fastify;
  };
  return {
    fastify: getFastify,
    openapi: async () => {
      assertApi(explicitModel, 'openapi');
      const document = createOpenapi({
        document: buildOpenapiDocument({ model: explicitModel, files: filesEnabled, pageSize, maxPageSize, info: normalizedConfig.openapi.info }),
        host: normalizedConfig.server.host,
        port: normalizedConfig.server.port,
      });
      if (normalizedConfig.openapi.path) await writeOpenapi(document, normalizedConfig.openapi.path);
      return document;
    },
    graphql: async () => {
      const sdl = printSchema(getGraphql());
      if (normalizedConfig.graphql.path) {
        await mkdir(dirname(normalizedConfig.graphql.path), { recursive: true });
        await writeFile(normalizedConfig.graphql.path, `${sdl}\n`, 'utf8');
      }
      return sdl;
    },
  };
}
