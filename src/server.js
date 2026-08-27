import Fastify from 'fastify';
import { JSONFilePreset } from 'lowdb/node';
import { randomBytes } from 'node:crypto';
import { matchesWhere, paginateItems, parseWhere, sortItems } from './query.js';
import { embedItem, parseEmbedPaths } from './relations.js';
import { createHttpError, getResourceNames, isObject, isSafeKey, resolveDatabasePath } from './utils.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};

const getCollection = (database, resource) => {
  const collection = isSafeKey(resource) ? database.data[resource] : undefined;

  if (!Array.isArray(collection)) {
    throw createHttpError(404, 'Ресурс не найден');
  }

  return collection;
};

const getRequestBody = (body) => {
  if (!isObject(body)) {
    throw createHttpError(400, 'Тело запроса должно быть JSON-объектом');
  }

  return body;
};

const findItem = (collection, id) => collection.find((item) => isObject(item) && String(item.id) === id);

export async function createServer({ databasePath, logger = true } = {}) {
  const database = await JSONFilePreset(resolveDatabasePath(databasePath), {});
  const server = Fastify({ logger });

  server.addHook('onRequest', async(_request, reply) => {
    Object.entries(CORS_HEADERS).forEach(([header, value]) => reply.header(header, value));
  });

  server.addHook('preHandler', async() => {
    await database.read();
  });

  server.options('/', async(_request, reply) => reply.code(204).send());
  server.options('/*', async(_request, reply) => reply.code(204).send());
  server.get('/', async() => ({ resources: getResourceNames(database.data) }));

  server.get('/:resource', async(request) => {
    const collection = getCollection(database, request.params.resource);
    const where = parseWhere(request.query);
    const embedPaths = parseEmbedPaths(request.query._embed);
    const embeddedItems = collection.map((item) => embedItem(database, item, request.params.resource, embedPaths));
    const filteredItems = embeddedItems.filter((item) => matchesWhere(item, where));
    const sortedItems = sortItems(filteredItems, request.query._sort);
    const page = request.query._page == null ? undefined : Number(request.query._page);

    return page == null ? sortedItems : paginateItems(sortedItems, page, Number(request.query._per_page));
  });

  server.get('/:resource/:id', async(request) => {
    const item = findItem(getCollection(database, request.params.resource), request.params.id);

    if (item == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    return embedItem(database, item, request.params.resource, parseEmbedPaths(request.query._embed));
  });

  server.post('/:resource', async(request, reply) => {
    const collection = getCollection(database, request.params.resource);
    const item = { ...getRequestBody(request.body), id: randomBytes(8).toString('base64url') };

    collection.push(item);
    await database.write();

    return reply.code(201).send(item);
  });

  server.put('/:resource/:id', async(request) => {
    const collection = getCollection(database, request.params.resource);
    const currentItem = findItem(collection, request.params.id);

    if (currentItem == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    const item = { ...getRequestBody(request.body), id: request.params.id };

    collection.splice(collection.indexOf(currentItem), 1, item);
    await database.write();

    return item;
  });

  server.patch('/:resource/:id', async(request) => {
    const collection = getCollection(database, request.params.resource);
    const currentItem = findItem(collection, request.params.id);

    if (currentItem == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    const item = { ...currentItem, ...getRequestBody(request.body), id: request.params.id };

    collection.splice(collection.indexOf(currentItem), 1, item);
    await database.write();

    return item;
  });

  server.delete('/:resource/:id', async(request) => {
    const collection = getCollection(database, request.params.resource);
    const currentItem = findItem(collection, request.params.id);

    if (currentItem == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    collection.splice(collection.indexOf(currentItem), 1);
    await database.write();

    return currentItem;
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

export async function startServer({ databasePath, host = '127.0.0.1', logger = true, port = 4001 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Порт должен быть целым числом от 1 до 65535');
  }

  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const server = await createServer({ databasePath: resolvedDatabasePath, logger });

  await server.listen({ host, port });
  server.log.info({ database: resolvedDatabasePath }, 'Deep JSON Server запущен');

  return server;
}
