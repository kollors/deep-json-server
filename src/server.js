import Fastify from 'fastify';
import { normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_MAX_PAGE_SIZE, DEFAULT_PORT } from './constants.js';
import { createDatabaseStore, createId, findItem, getCollection } from './database.js';
import { createFileStore, registerFileRoutes } from './files/index.js';
import { resolveSchemaConfig } from './openapi/config.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi, writeOpenapi } from './openapi/index.js';
import { matchesWhere, paginateItems, parsePagination, parseWhere, sortItems, validateWhere } from './query/index.js';
import { embedItem, parseEmbedPaths, validateEmbedPaths } from './relations.js';
import { createHttpError, getResourceNames } from './utils.js';

/** @typedef {Record<string, unknown>} OpenapiDocument */
/** @typedef {{ fastify: () => import('fastify').FastifyInstance, openapi: () => Promise<OpenapiDocument> }} ServerFacade */

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Directory, Content-Name, Content-Override, Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};

const getSchemaName = (reference) => reference.split('/').at(-1);

const addRequestSchemas = (fastify, document, resources) => {
  const requestSchemaNames = new Set(
    resources.flatMap((resource) => {
      const resourcePath = document.paths[`/${resource}`];
      const itemPath = document.paths[`/${resource}/{id}`];

      return [getSchemaName(resourcePath.post.requestBody.content['application/json'].schema.$ref), getSchemaName(itemPath.patch.requestBody.content['application/json'].schema.$ref)];
    }),
  );

  requestSchemaNames.forEach((schemaName) => {
    fastify.addSchema({ $id: schemaName, ...document.components.schemas[schemaName] });
  });
};

const registerResourceRoutes = (fastify, store, resource, document, maxPageSize) => {
  const resourcePath = `/${resource}`;
  const itemPath = `/${resource}/:id`;
  const createSchemaName = getSchemaName(document.paths[resourcePath].post.requestBody.content['application/json'].schema.$ref);
  const updateSchemaName = getSchemaName(document.paths[`/${resource}/{id}`].patch.requestBody.content['application/json'].schema.$ref);

  fastify.get(resourcePath, async (request) => {
    await store.read();

    const collection = getCollection(store.database, resource);
    const where = parseWhere(request.query);
    const embedPaths = parseEmbedPaths(request.query._embed);
    const pagination = parsePagination(request.query, maxPageSize);

    validateEmbedPaths(store.database, resource, collection, embedPaths);

    const relationIndexes = new Map();
    const embeddedItems = collection.map((item) => embedItem(store.database, item, resource, embedPaths, relationIndexes));

    validateWhere(where, embeddedItems);

    const filteredItems = embeddedItems.filter((item) => matchesWhere(item, where));
    const sortedItems = sortItems(filteredItems, request.query._sort, embeddedItems);

    return paginateItems(sortedItems, pagination.page, pagination.pageSize);
  });

  fastify.get(itemPath, async (request) => {
    await store.read();

    const collection = getCollection(store.database, resource);
    const item = findItem(collection, request.params.id);
    const embedPaths = parseEmbedPaths(request.query._embed);

    if (item == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    validateEmbedPaths(store.database, resource, collection, embedPaths);

    return embedItem(store.database, item, resource, embedPaths);
  });

  fastify.post(resourcePath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request, reply) => {
    const item = await store.update((database) => {
      const collection = getCollection(database, resource);
      const createdItem = { ...request.body, id: createId(collection) };

      collection.push(createdItem);

      return createdItem;
    });

    return reply.code(201).send(item);
  });

  fastify.put(itemPath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const collection = getCollection(database, resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...request.body, id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    }),
  );

  fastify.patch(itemPath, { schema: { body: { $ref: `${updateSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const collection = getCollection(database, resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...currentItem, ...request.body, id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    }),
  );

  fastify.delete(itemPath, async (request) =>
    store.update((database) => {
      const collection = getCollection(database, resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      collection.splice(collection.indexOf(currentItem), 1);

      return currentItem;
    }),
  );
};

/**
 * Creates lazy Fastify and OpenAPI accessors from one configuration.
 * @param {import('./config.js').DeepJsonServerConfig} config Server configuration.
 * @param {{ files?: boolean }} [features] Optional feature switches.
 * @returns {Promise<ServerFacade>} Server facade.
 */
export async function createServer(config, features = {}) {
  const normalizedConfig = normalizeServerConfig(config);
  const filesEnabled = features.files ?? normalizedConfig.files != null;
  const { logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxPageSize = DEFAULT_MAX_PAGE_SIZE } = normalizedConfig.server;
  const store = await createDatabaseStore(normalizedConfig.database);
  const schema = await resolveSchemaConfig(normalizedConfig.database.schema);
  let fileStorePromise;
  let fastifyInstance;

  if (filesEnabled && normalizedConfig.files == null) {
    throw new Error('Для файловых маршрутов укажите секцию config.files');
  }

  if (filesEnabled && 'data' in normalizedConfig.files) {
    fileStorePromise = Promise.resolve(await createFileStore(normalizedConfig.files));
  }

  const getFileStore = () => {
    if (fileStorePromise == null) {
      fileStorePromise = createFileStore(normalizedConfig.files);
    }

    return fileStorePromise;
  };

  const buildDocument = () =>
    buildOpenapiDocument({
      database: store.database.data,
      files: filesEnabled,
      maxPageSize,
      schema,
    });

  const getFastify = () => {
    if (fastifyInstance != null) {
      return fastifyInstance;
    }

    const document = buildDocument();
    const resources = getResourceNames(store.database.data);
    const fastify = Fastify({ logger });
    const originalListen = fastify.listen.bind(fastify);

    // Calling fastify().listen() without arguments uses config defaults.
    fastify.listen = (...args) => originalListen(...(args.length === 0 ? [{ host: normalizedConfig.server.host ?? DEFAULT_HOST, port: normalizedConfig.server.port ?? DEFAULT_PORT }] : args));

    addRequestSchemas(fastify, document, resources);

    fastify.addHook('onRequest', async (_request, reply) => {
      Object.entries(CORS_HEADERS).forEach(([header, value]) => {
        reply.header(header, value);
      });
    });

    fastify.options('/', async (_request, reply) => reply.code(204).send());
    fastify.options('/*', async (_request, reply) => reply.code(204).send());
    fastify.get('/', async () => ({ resources }));

    resources.forEach((resource) => {
      registerResourceRoutes(fastify, store, resource, document, maxPageSize);
    });

    if (filesEnabled) {
      registerFileRoutes(fastify, { getStore: getFileStore, maxFileSize });
    }

    fastify.setErrorHandler((error, request, reply) => {
      const candidateStatusCode = typeof error === 'object' && error != null && 'statusCode' in error ? error.statusCode : undefined;
      const statusCode = typeof candidateStatusCode === 'number' && Number.isInteger(candidateStatusCode) ? candidateStatusCode : 500;

      if (statusCode === 500) {
        request.log.error(error);
      }

      return reply.code(statusCode).send({ error: error instanceof Error ? error.message : 'Внутренняя ошибка сервера' });
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
