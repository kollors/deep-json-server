import Fastify from 'fastify';
import { normalizeServerConfig } from './config.js';
import { DEFAULT_HOST, DEFAULT_MAX_FILE_SIZE, DEFAULT_PORT, MAX_PAGE_SIZE } from './constants.js';
import { createDatabaseStore, createId, findItem, getCollection } from './database.js';
import { createFileStore, registerFileRoutes } from './files.js';
import { resolveSchemaConfig } from './openapi/config.js';
import { buildOpenapiDocument } from './openapi/document.js';
import { createOpenapi, writeOpenapi } from './openapi/index.js';
import { matchesWhere, paginateItems, parsePagination, parseWhere, sortItems, validateWhere } from './query/index.js';
import { embedItem, parseEmbedPaths, validateEmbedPaths } from './relations.js';
import { createHttpError, getResourceNames, isObject } from './utils.js';

/** @typedef {Record<string, unknown>} OpenapiDocument */

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Name, Content-Type',
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
 * Creates a Deep JSON Server facade.
 * @param {import('./config.js').DeepJsonServerConfig} options Server options.
 * @param {{ files?: boolean }} [features] Optional feature switches.
 * @returns {Promise<{ fastify: () => import('fastify').FastifyInstance, openapi: () => Promise<OpenapiDocument> }>} Server facade.
 */
export async function createServer(options, features = {}) {
  const config = normalizeServerConfig(options);
  const filesEnabled = features.files ?? config.files != null;
  const { logger = true, maxFileSize = DEFAULT_MAX_FILE_SIZE, maxPageSize = MAX_PAGE_SIZE } = config.server;
  const store = await createDatabaseStore(config.database);
  const schema = await resolveSchemaConfig(config.database.schema);
  const fileStore = filesEnabled && config.files != null ? await createFileStore(config.files) : undefined;
  let fastifyInstance;

  if (filesEnabled && config.files == null) {
    throw new Error('Для файловых маршрутов укажите секцию config.files');
  }

  const buildDocument = () =>
    buildOpenapiDocument({
      database: store.database.data,
      files: filesEnabled,
      maxPageSize,
      schema,
    });

  const fastify = () => {
    if (fastifyInstance != null) {
      return fastifyInstance;
    }

    const document = buildDocument();
    const resources = getResourceNames(store.database.data);
    const server = Fastify({ logger });
    const listen = server.listen.bind(server);

    server.listen = (...args) => listen(...(args.length === 0 ? [{ host: config.server.host ?? DEFAULT_HOST, port: config.server.port ?? DEFAULT_PORT }] : args));

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

    if (fileStore != null) {
      registerFileRoutes(server, { maxFileSize, store: fileStore });
    }

    server.setErrorHandler((error, request, reply) => {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

      if (statusCode === 500) {
        request.log.error(error);
      }

      return reply.code(statusCode).send({ error: error.message });
    });

    fastifyInstance = server;

    return fastifyInstance;
  };

  const openapi = async () => {
    await store.read();

    const document = createOpenapi({
      database: store.database.data,
      files: filesEnabled,
      host: config.server.host,
      maxPageSize,
      port: config.server.port,
      schema,
    });

    if (config.openapi.path != null) {
      await writeOpenapi(document, config.openapi.path);
    }

    return document;
  };

  return { fastify, openapi };
}
