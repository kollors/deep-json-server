import type { FastifyInstance } from 'fastify';
import { AUTH_PATHS } from '../auth/contract.js';
import type { Model } from '../core/model.js';
import { inputPaths } from '../core/paths.js';
import { configSourcePath, type NormalizedServerConfig } from './config.js';
import { validateEndpoints } from './features.js';

/** Подключает к HTTP-серверу хранилище записей и включённые прикладные модули.
 * @example Конфигурация только с базой → REST-маршруты без auth, files и API-экспортов.
 */
export async function registerConfiguredModules(
  app: FastifyInstance,
  config: NormalizedServerConfig,
  explicitModel: Model | undefined,
  openapi: () => Promise<import('../openapi/types.js').OpenapiDocument>,
): Promise<void> {
  const enabled = { auth: config.auth !== undefined, files: config.files !== undefined };
  const recordSettings = { auth: enabled.auth };
  const keys = explicitModel ? new Map(explicitModel.entities.map((entity) => [entity.collection, entity.primary])) : undefined;
  const [{ createDatabaseStore }, { Engine }, { inferModel }, { registerRestRoutes }] = await Promise.all([
    import('../core/database.js'),
    import('../core/engine.js'),
    import('../core/model.js'),
    import('../rest/routes.js'),
  ]);
  const store = await createDatabaseStore(config.database, keys);
  const model = explicitModel ?? inferModel(store.database.data, recordSettings);
  const engine = new Engine(store, model, config.server.pageSize, config.server.maxPageSize);
  engine.validateData(store.database.data);
  const graphqlPath = config.graphql?.endpoint;
  const openapiPath = config.openapi?.endpoint;
  validateEndpoints(
    model.entities.map((entity) => entity.collection),
    [...(graphqlPath ? [graphqlPath] : []), ...(openapiPath ? [openapiPath] : []), ...(enabled.auth ? Object.values(AUTH_PATHS) : [])],
  );
  const auth = enabled.auth && config.auth ? await (await import('../auth/service.js')).createAuthService(config.auth) : undefined;
  if (auth) {
    app.addHook('onClose', async () => auth.close());
    const { registerAuthRoutes } = await import('../auth/routes.js');
    registerAuthRoutes(app, auth);
  }
  const authenticate = auth ? (header: unknown) => auth.me(header) : undefined;
  registerRestRoutes(app, engine, authenticate);
  if (graphqlPath) {
    const [{ registerGraphqlRoutes }, { buildGraphql }] = await Promise.all([import('../graphql/routes.js'), import('../graphql/schema.js')]);
    registerGraphqlRoutes(app, buildGraphql(model), engine, graphqlPath, authenticate);
  }
  if (openapiPath) {
    const document = await openapi();
    document.servers = [{ url: '/' }];
    app.get(openapiPath, async () => document);
  }
  if (enabled.files && config.files) {
    const { createFileStore, registerFileRoutes } = await import('../files/index.js');
    const protectedPaths = inputPaths({ database: config.database, auth: config.auth }, '.', configSourcePath(config));
    registerFileRoutes(app, { getStore: () => createFileStore(config.files as NonNullable<typeof config.files>, protectedPaths), maxFileSize: config.server.maxFileSize });
  }
}
