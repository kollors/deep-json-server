import type { FastifyInstance, FastifyListenOptions } from 'fastify';
import { AUTH_PATHS } from '../auth/contract.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_PORT } from '../core/constants.js';
import { DomainError } from '../core/errors.js';
import { domainStatus } from '../core/http-errors.js';
import { normalizePagination } from '../core/pagination.js';
import { inputPaths } from '../core/paths.js';
import { errorMessage, isObject } from '../core/utils.js';
import type { OpenapiDocument } from '../openapi/types.js';
import { configSourcePath, type DeepJsonServerConfig, type NormalizedServerConfig, normalizeServerConfig } from './config.js';
import { resolveFeatures, type ServerFeatures, validateEndpoints } from './features.js';
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
/** Проверяет настройки и создаёт интерфейс запуска и генерации схем; сетевой порт ещё не открывает.
 * @example await createServer({ database: { data: { notes: [] } } }) → объект с fastify(), openapi(), graphql().
 */
export async function createServer(config: DeepJsonServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  return createConfiguredServer(normalizeServerConfig(config), features);
}
/** Собирает сервер из нормализованных настроек; хранилища открываются при инициализации HTTP-экземпляра.
 * @example Нормализованные настройки → Promise<ServerFacade>; listen() затем открывает сетевой порт.
 */
export async function createConfiguredServer(normalized: NormalizedServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  const enabled = resolveFeatures(normalized, features);
  const { loadModel, inferModel } = await import('../core/model.js');
  const recordSettings = { timestamps: normalized.database.timestamps, softDelete: normalized.database.softDelete, auth: enabled.auth };
  const explicitModel = await loadModel(normalized.database.schema, recordSettings);
  const { default: Fastify } = await import('fastify');
  const corsHeaders = { ...CORS_HEADERS };
  if (enabled.files) {
    const { FILE_HEADERS } = await import('../files/http.js');
    corsHeaders['Access-Control-Allow-Headers'] = [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', ');
  }
  if (enabled.auth) corsHeaders['Access-Control-Allow-Headers'] += ', Authorization';
  const { cors = true, logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE } = normalized.server;
  const { pageSize, maxPageSize } = normalizePagination(normalized.server);
  const openapi = async () =>
    (await import('../openapi/public.js')).openapiFromModel(explicitModel, {
      files: enabled.files,
      ...recordSettings,
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
      return reply.code(status).send({ error: status === 500 ? 'Внутренняя ошибка сервера' : errorMessage(error) });
    });
    if (cors) {
      server.addHook('onRequest', async (_request, reply) => {
        for (const [key, value] of Object.entries(corsHeaders)) reply.header(key, value);
      });
      server.options('/', async (_request, reply) => reply.code(204).send());
      server.options('/*', async (_request, reply) => reply.code(204).send());
    }
    server.register(async (app) => {
      const [{ createDatabaseStore }, { Engine }, { registerRestRoutes }] = await Promise.all([import('../core/database.js'), import('../core/engine.js'), import('../rest/routes.js')]);
      const keys = explicitModel ? new Map(explicitModel.entities.map((e) => [e.collection, e.primary])) : undefined;
      const store = await createDatabaseStore(normalized.database, keys);
      const model = explicitModel ?? inferModel(store.database.data, recordSettings);
      const engine = new Engine(store, model, pageSize, maxPageSize);
      engine.validateData(store.database.data);
      const graphqlPath = normalized.graphql.endpoint ?? '/graphql';
      const openapiPath = normalized.openapi.endpoint ?? '/openapi.json';
      validateEndpoints(
        model.entities.map((entity) => entity.collection),
        [...(enabled.graphql ? [graphqlPath] : []), ...(enabled.openapi ? [openapiPath] : []), ...(enabled.auth ? Object.values(AUTH_PATHS) : [])],
      );
      const auth = enabled.auth && normalized.auth ? await (await import('../auth/service.js')).createAuthService(normalized.auth) : undefined;
      if (auth) {
        app.addHook('onClose', async () => auth.close());
        const { registerAuthRoutes } = await import('../auth/routes.js');
        registerAuthRoutes(app, auth);
      }
      const authenticate = auth ? (header: unknown) => auth.me(header) : undefined;
      registerRestRoutes(app, engine, authenticate);
      if (enabled.graphql) {
        const [{ registerGraphqlRoutes }, { buildGraphql }] = await Promise.all([import('../graphql/routes.js'), import('../graphql/schema.js')]);
        registerGraphqlRoutes(app, buildGraphql(model), engine, graphqlPath, authenticate);
      }
      if (enabled.openapi) {
        const document = await openapi();
        document.servers = [{ url: '/' }];
        app.get(openapiPath, async () => document);
      }
      const files = normalized.files;
      if (enabled.files && files) {
        const { createFileStore, registerFileRoutes } = await import('../files/index.js');
        const protectedPaths = inputPaths({ database: normalized.database, auth: normalized.auth }, '.', configSourcePath(normalized));
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
      return (await import('../graphql/public.js')).graphqlFromModel(explicitModel);
    },
  };
}
