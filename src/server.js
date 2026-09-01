import Fastify from 'fastify';
import { DEFAULT_HOST, DEFAULT_PORT, MAX_PAGE_SIZE } from './constants.js';
import { createDatabaseStore, createId, findItem, getCollection } from './database.js';
import { readSchemaConfig } from './openapi/config.js';
import { createOpenApiDocument } from './openapi/index.js';
import { matchesWhere, paginateItems, parsePagination, parseWhere, sortItems, validateWhere } from './query/index.js';
import { embedItem, parseEmbedPaths, validateEmbedPaths } from './relations.js';
import { createHttpError, getResourceNames, isObject, resolveDatabasePath } from './utils.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};

const getRequestBody = (body) => {
  if (!isObject(body)) {
    throw createHttpError(400, 'Тело запроса должно быть JSON-объектом');
  }

  return body;
};

const getSchemaName = (reference) => reference.split('/').at(-1);

const addRequestSchemas = (server, document, resources) => {
  const requestSchemaNames = new Set(
    resources.flatMap((resource) => {
      const resourcePath = document.paths[`/${resource}`];
      const itemPath = document.paths[`/${resource}/{id}`];

      return [getSchemaName(resourcePath.post.requestBody.content['application/json'].schema.$ref), getSchemaName(itemPath.patch.requestBody.content['application/json'].schema.$ref)];
    }),
  );

  requestSchemaNames.forEach((schemaName) => {
    server.addSchema({ $id: schemaName, ...document.components.schemas[schemaName] });
  });
};

const registerResourceRoutes = (server, store, resource, document, maxPageSize) => {
  const resourcePath = `/${resource}`;
  const itemPath = `/${resource}/:id`;
  const createSchemaName = getSchemaName(document.paths[resourcePath].post.requestBody.content['application/json'].schema.$ref);
  const updateSchemaName = getSchemaName(document.paths[`/${resource}/{id}`].patch.requestBody.content['application/json'].schema.$ref);

  server.get(resourcePath, async (request) => {
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

  server.get(itemPath, async (request) => {
    const collection = getCollection(store.database, resource);
    const item = findItem(collection, request.params.id);
    const embedPaths = parseEmbedPaths(request.query._embed);

    if (item == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    validateEmbedPaths(store.database, resource, collection, embedPaths);

    return embedItem(store.database, item, resource, embedPaths);
  });

  server.post(resourcePath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request, reply) => {
    const item = await store.update((database) => {
      const collection = getCollection(database, resource);
      const createdItem = { ...getRequestBody(request.body), id: createId(collection) };

      collection.push(createdItem);

      return createdItem;
    });

    return reply.code(201).send(item);
  });

  server.put(itemPath, { schema: { body: { $ref: `${createSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const collection = getCollection(database, resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...getRequestBody(request.body), id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    }),
  );

  server.patch(itemPath, { schema: { body: { $ref: `${updateSchemaName}#` } } }, async (request) =>
    store.update((database) => {
      const collection = getCollection(database, resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...currentItem, ...getRequestBody(request.body), id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    }),
  );

  server.delete(itemPath, async (request) =>
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
 * Creates a Fastify server without opening a network port.
 * @param {{ databasePath: string, logger?: boolean | Record<string, unknown>, maxPageSize?: number, schemaPath?: string }} options Server options.
 * @returns {Promise<import('fastify').FastifyInstance>} Fastify server.
 */
export async function createServer(options) {
  const { databasePath, logger = true, maxPageSize = MAX_PAGE_SIZE, schemaPath } = options ?? {};

  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new Error('Максимальный размер страницы должен быть положительным целым числом');
  }

  const store = await createDatabaseStore(databasePath);
  const schemaConfig = await readSchemaConfig(schemaPath);
  const document = createOpenApiDocument(store.database.data, schemaConfig);
  const resources = getResourceNames(store.database.data);
  const server = Fastify({ logger });

  addRequestSchemas(server, document, resources);

  server.addHook('onRequest', async (_request, reply) => {
    Object.entries(CORS_HEADERS).forEach(([header, value]) => {
      reply.header(header, value);
    });
  });

  server.addHook('preHandler', async (request) => {
    if (request.method === 'GET') {
      await store.read();
    }
  });

  server.options('/', async (_request, reply) => reply.code(204).send());
  server.options('/*', async (_request, reply) => reply.code(204).send());
  server.get('/', async () => ({ resources }));

  resources.forEach((resource) => {
    registerResourceRoutes(server, store, resource, document, maxPageSize);
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

    if (statusCode === 500) {
      request.log.error(error);
    }

    return reply.code(statusCode).send({ error: error.message });
  });

  return server;
}

/**
 * Creates and starts a Fastify server.
 * @param {{ databasePath: string, host?: string, logger?: boolean | Record<string, unknown>, maxPageSize?: number, port?: number, schemaPath?: string }} options Server options.
 * @returns {Promise<import('fastify').FastifyInstance>} Listening Fastify server.
 */
export async function startServer(options) {
  const { databasePath, host = DEFAULT_HOST, logger = true, maxPageSize = MAX_PAGE_SIZE, port = DEFAULT_PORT, schemaPath } = options ?? {};

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Порт должен быть целым числом от 0 до 65535');
  }

  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const server = await createServer({ databasePath: resolvedDatabasePath, logger, maxPageSize, schemaPath });

  await server.listen({ host, port });
  server.log.info({ database: resolvedDatabasePath }, 'Deep JSON Server запущен');

  return server;
}
