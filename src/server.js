import Fastify from 'fastify';
import { JSONFilePreset } from 'lowdb/node';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { matchesWhere, paginateItems, parsePagination, parseWhere, sortItems, validateWhere } from './query.js';
import { embedItem, parseEmbedPaths } from './relations.js';
import { createHttpError, getResourceNames, isObject, isSafeKey, resolveDatabasePath, validateDatabase } from './utils.js';

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

const readDatabaseFile = async(databasePath) => {
  let source;

  try {
    source = await readFile(databasePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Файл базы данных не найден: ${databasePath}`);
    }

    throw error;
  }

  const data = JSON.parse(source);

  return validateDatabase(data);
};

export async function createServer({ databasePath, logger = true } = {}) {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const initialData = await readDatabaseFile(resolvedDatabasePath);
  const database = await JSONFilePreset(resolvedDatabasePath, initialData);
  const server = Fastify({ logger });
  let databaseWriteQueue = Promise.resolve();

  const readDatabase = async() => {
    database.data = await readDatabaseFile(resolvedDatabasePath);
  };

  const updateDatabase = (update) => {
    const operation = databaseWriteQueue.then(async() => {
      await readDatabase();

      const result = update();

      await database.write();

      return result;
    });

    databaseWriteQueue = operation.catch(() => undefined);

    return operation;
  };

  server.addHook('onRequest', async(_request, reply) => {
    Object.entries(CORS_HEADERS).forEach(([header, value]) => reply.header(header, value));
  });

  server.addHook('preHandler', async(request) => {
    if (request.method === 'GET') {
      await readDatabase();
    }
  });

  server.options('/', async(_request, reply) => reply.code(204).send());
  server.options('/*', async(_request, reply) => reply.code(204).send());
  server.get('/', async() => ({ resources: getResourceNames(database.data) }));

  server.get('/:resource', async(request) => {
    const collection = getCollection(database, request.params.resource);
    const where = parseWhere(request.query);
    const embedPaths = parseEmbedPaths(request.query._embed);
    const relationIndexes = new Map();
    const embeddedItems = collection.map((item) => embedItem(database, item, request.params.resource, embedPaths, relationIndexes));
    const pagination = parsePagination(request.query);

    validateWhere(where, embeddedItems);

    const filteredItems = embeddedItems.filter((item) => matchesWhere(item, where));
    const sortedItems = sortItems(filteredItems, request.query._sort);

    return paginateItems(sortedItems, pagination.page, pagination.pageSize);
  });

  server.get('/:resource/:id', async(request) => {
    const item = findItem(getCollection(database, request.params.resource), request.params.id);

    if (item == null) {
      throw createHttpError(404, 'Запись не найдена');
    }

    return embedItem(database, item, request.params.resource, parseEmbedPaths(request.query._embed));
  });

  server.post('/:resource', async(request, reply) => {
    const item = await updateDatabase(() => {
      const collection = getCollection(database, request.params.resource);
      const createdItem = { ...getRequestBody(request.body), id: randomBytes(8).toString('base64url') };

      collection.push(createdItem);

      return createdItem;
    });

    return reply.code(201).send(item);
  });

  server.put('/:resource/:id', async(request) => {
    return updateDatabase(() => {
      const collection = getCollection(database, request.params.resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...getRequestBody(request.body), id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    });
  });

  server.patch('/:resource/:id', async(request) => {
    return updateDatabase(() => {
      const collection = getCollection(database, request.params.resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      const item = { ...currentItem, ...getRequestBody(request.body), id: currentItem.id };

      collection.splice(collection.indexOf(currentItem), 1, item);

      return item;
    });
  });

  server.delete('/:resource/:id', async(request) => {
    return updateDatabase(() => {
      const collection = getCollection(database, request.params.resource);
      const currentItem = findItem(collection, request.params.id);

      if (currentItem == null) {
        throw createHttpError(404, 'Запись не найдена');
      }

      collection.splice(collection.indexOf(currentItem), 1);

      return currentItem;
    });
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
