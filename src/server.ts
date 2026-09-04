import Fastify, { type FastifyInstance, type FastifyListenOptions } from 'fastify';
import { type DeepJsonServerConfig, normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_MAX_PAGE_SIZE, DEFAULT_PORT } from './constants.js';
import type { DatabaseContainer, DatabaseStore } from './database.js';
import { createDatabaseStore, createId, findItemIndex, getCollection } from './database.js';
import { FILE_HEADERS } from './files/contract.js';
import { createFileStore, registerFileRoutes } from './files/index.js';
import { resolveSchemaConfig } from './openapi/config.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi, writeOpenapi } from './openapi/index.js';
import { matchesWhere, paginateItems, parsePagination, parseWhere, sortItems, validateWhere } from './query/index.js';
import { createRelationContext, embedItem, parseEmbedPaths, validateEmbedPaths } from './relations.js';
import type { DatabaseId, DatabaseRecord, JsonObject, OpenapiDocument, Query } from './types.js';
import { createHttpError, getResourceNames, isObject } from './utils.js';

export interface ServerFacade {
  fastify(): FastifyInstance;
  openapi(): Promise<OpenapiDocument>;
}

interface ServerFeatures {
  files?: boolean;
}

interface ItemParams {
  id: string;
}

type ListenCallback = (error: Error | null, address: string) => void;

interface RequestSchemaOperation {
  requestBody: {
    content: {
      'application/json': {
        schema: { $ref: string };
      };
    };
  };
}

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': [...Object.values(FILE_HEADERS).map(({ name }) => name), 'Content-Type'].join(', '),
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};

const getSchemaName = (reference: string): string => reference.split('/').at(-1) as string;

const addRequestSchemas = (fastify: FastifyInstance, document: OpenapiDocument, resources: string[]): void => {
  const requestSchemaNames = new Set(
    resources.flatMap((resource) => {
      const resourcePath = document.paths[`/${resource}`] as { post: RequestSchemaOperation };
      const itemPath = document.paths[`/${resource}/{id}`] as { patch: RequestSchemaOperation };

      return [getSchemaName(resourcePath.post.requestBody.content['application/json'].schema.$ref), getSchemaName(itemPath.patch.requestBody.content['application/json'].schema.$ref)];
    }),
  );

  requestSchemaNames.forEach((schemaName) => {
    fastify.addSchema({ $id: schemaName, ...document.components.schemas[schemaName] });
  });
};

const getCollectionItem = (database: DatabaseContainer, resource: string, id: DatabaseId): { collection: DatabaseRecord[]; index: number; item: DatabaseRecord } => {
  const collection = getCollection(database, resource);
  const index = findItemIndex(collection, id);

  if (index === -1) {
    throw createHttpError(404, 'Запись не найдена');
  }

  return { collection, index, item: collection[index] };
};

const registerResourceRoutes = (fastify: FastifyInstance, store: DatabaseStore, resource: string, document: OpenapiDocument, maxPageSize: number): void => {
  const resourcePath = `/${resource}`;
  const itemPath = `/${resource}/:id`;
  const createOperation = document.paths[resourcePath].post as RequestSchemaOperation;
  const updateOperation = document.paths[`/${resource}/{id}`].patch as RequestSchemaOperation;
  const createSchemaName = getSchemaName(createOperation.requestBody.content['application/json'].schema.$ref);
  const updateSchemaName = getSchemaName(updateOperation.requestBody.content['application/json'].schema.$ref);

  fastify.get(resourcePath, async (request) => {
    await store.read();

    const collection = getCollection(store.database, resource);
    const query = request.query as Query;
    const where = parseWhere(query);
    const embedPaths = parseEmbedPaths(query._embed);
    const pagination = parsePagination(query, maxPageSize);

    validateEmbedPaths(store.database, resource, collection, embedPaths);

    const relationContext = createRelationContext(store.database);
    const embeddedItems = collection.map((item) => embedItem(store.database, item, resource, embedPaths, relationContext));

    validateWhere(where, embeddedItems);

    const filteredItems = embeddedItems.filter((item) => matchesWhere(item, where));
    const sortedItems = sortItems(filteredItems, query._sort, embeddedItems);

    return paginateItems(sortedItems, pagination.page, pagination.pageSize);
  });

  fastify.get(itemPath, async (request) => {
    await store.read();

    const params = request.params as ItemParams;
    const query = request.query as Query;
    const { collection, item } = getCollectionItem(store.database, resource, params.id);
    const embedPaths = parseEmbedPaths(query._embed);

    validateEmbedPaths(store.database, resource, collection, embedPaths);

    return embedItem(store.database, item, resource, embedPaths);
  });

  fastify.post(resourcePath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request, reply) => {
    const item = await store.update((database) => {
      const collection = getCollection(database, resource);
      const createdItem = { ...(request.body as JsonObject), id: createId(collection) } as DatabaseRecord;

      collection.push(createdItem);

      return createdItem;
    });

    return reply.code(201).send(item);
  });

  fastify.put(itemPath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const { collection, index, item: currentItem } = getCollectionItem(database, resource, (request.params as ItemParams).id);

      const item = { ...(request.body as JsonObject), id: currentItem.id } as DatabaseRecord;

      collection.splice(index, 1, item);

      return item;
    }),
  );

  fastify.patch(itemPath, { schema: { body: { $ref: `${updateSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const { collection, index, item: currentItem } = getCollectionItem(database, resource, (request.params as ItemParams).id);

      const item = { ...currentItem, ...(request.body as JsonObject), id: currentItem.id } as DatabaseRecord;

      collection.splice(index, 1, item);

      return item;
    }),
  );

  fastify.delete(itemPath, async (request) =>
    store.update((database) => {
      const { collection, index, item } = getCollectionItem(database, resource, (request.params as ItemParams).id);

      collection.splice(index, 1);

      return item;
    }),
  );
};

/** Creates lazy Fastify and OpenAPI accessors from one configuration. */
export async function createServer(config: DeepJsonServerConfig, features: ServerFeatures = {}): Promise<ServerFacade> {
  if (!isObject(features) || Object.keys(features).some((key) => key !== 'files') || (features.files != null && typeof features.files !== 'boolean')) {
    throw new Error('Параметр features должен содержать только необязательный boolean-ключ files');
  }

  const normalizedConfig = normalizeServerConfig(config);
  const filesEnabled = features.files ?? normalizedConfig.files != null;
  const { cors = true, logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxPageSize = DEFAULT_MAX_PAGE_SIZE } = normalizedConfig.server;
  const store = await createDatabaseStore(normalizedConfig.database);
  const schema = await resolveSchemaConfig(normalizedConfig.database.schema);
  let fileStorePromise: ReturnType<typeof createFileStore> | undefined;
  let fastifyInstance: FastifyInstance | undefined;

  if (filesEnabled && normalizedConfig.files == null) {
    throw new Error('Для файловых маршрутов укажите секцию config.files');
  }

  const getFileStore = () => (fileStorePromise ??= createFileStore(normalizedConfig.files as NonNullable<typeof normalizedConfig.files>));

  if (filesEnabled && normalizedConfig.files?.data != null) {
    await getFileStore();
  }

  const buildDocument = () =>
    buildOpenapiDocument({
      database: store.database.data,
      files: filesEnabled,
      maxPageSize,
      schema,
    });

  const getFastify = (): FastifyInstance => {
    if (fastifyInstance != null) {
      return fastifyInstance;
    }

    const document = buildDocument();
    const resources = getResourceNames(store.database.data);
    const fastify = Fastify({ logger });
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

    addRequestSchemas(fastify, document, resources);

    if (cors) {
      fastify.addHook('onRequest', async (_request, reply) => {
        Object.entries(CORS_HEADERS).forEach(([header, value]) => {
          reply.header(header, value);
        });
      });

      fastify.options('/', async (_request, reply) => reply.code(204).send());
      fastify.options('/*', async (_request, reply) => reply.code(204).send());
    }
    fastify.get('/', async () => ({ resources }));

    resources.forEach((resource) => {
      registerResourceRoutes(fastify, store, resource, document, maxPageSize);
    });

    if (filesEnabled) {
      registerFileRoutes(fastify, { getStore: getFileStore, maxFileSize });
    }

    fastify.setErrorHandler((error, request, reply) => {
      const candidateStatusCode = typeof error === 'object' && error != null && 'statusCode' in error ? error.statusCode : undefined;
      const statusCode = typeof candidateStatusCode === 'number' && Number.isInteger(candidateStatusCode) && candidateStatusCode >= 400 && candidateStatusCode <= 599 ? candidateStatusCode : 500;

      if (statusCode === 500) {
        request.log.error(error);
      }

      return reply.code(statusCode).send({ error: statusCode === 500 ? 'Внутренняя ошибка сервера' : error instanceof Error ? error.message : String(error) });
    });

    fastifyInstance = fastify;

    return fastifyInstance;
  };

  const openapi = async () => {
    await store.read();

    const document = createOpenapi({
      database: store.database.data,
      files: filesEnabled,
      host: normalizedConfig.server.host,
      maxPageSize,
      port: normalizedConfig.server.port,
      schema,
    });

    if (normalizedConfig.openapi.path != null) {
      await writeOpenapi(document, normalizedConfig.openapi.path);
    }

    return document;
  };

  return { fastify: getFastify, openapi };
}
