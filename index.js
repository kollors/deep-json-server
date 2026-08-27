#!/usr/bin/env node

import Fastify from 'fastify';
import { JSONFilePreset } from 'lowdb/node';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const FIELD_OPERATORS = new Set(['contains', 'endsWith', 'eq', 'every', 'gt', 'gte', 'in', 'lt', 'lte', 'ne', 'none', 'not', 'some', 'startsWith']);
const RESERVED_QUERY_KEYS = new Set(['_embed', '_page', '_per_page', '_sort', '_where']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const CORS_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PATCH, POST, PUT',
  'Access-Control-Allow-Origin': '*',
};

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isSafeKey = (key) => !UNSAFE_KEYS.has(key);
const toArray = (value) => (Array.isArray(value) ? value : [value]);

const createHttpError = (statusCode, message) => {
  const error = new Error(message);

  error.statusCode = statusCode;

  return error;
};

const isEqual = (left, right) => {
  if (Object.is(left, right)) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => isEqual(value, right[index]));
  }

  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);

    return leftKeys.length === rightKeys.length && leftKeys.every((key) => isSafeKey(key) && Object.hasOwn(right, key) && isEqual(left[key], right[key]));
  }

  return false;
};

const compareValues = (left, right) => {
  if (Object.is(left, right)) {
    return 0;
  }

  if (left == null) {
    return 1;
  }

  if (right == null) {
    return -1;
  }

  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }

  return String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
};

const getValueByPath = (value, path) => path.split('.').reduce((currentValue, key) => {
  return isSafeKey(key) && currentValue != null ? currentValue[key] : undefined;
}, value);

const matchesOperator = (field, operator, expectedValue) => {
  switch (operator) {
    case 'contains':
      return typeof field === 'string'
        ? field.toLowerCase().includes(String(expectedValue).toLowerCase())
        : Array.isArray(field) && field.some((value) => isEqual(value, expectedValue));
    case 'endsWith':
      return typeof field === 'string' && field.toLowerCase().endsWith(String(expectedValue).toLowerCase());
    case 'eq':
      return isEqual(field, expectedValue);
    case 'every':
      return Array.isArray(field) && field.every((value) => matchesValue(value, expectedValue));
    case 'gt':
      return field != null && field > expectedValue;
    case 'gte':
      return field != null && field >= expectedValue;
    case 'in': {
      const expectedValues = toArray(expectedValue);

      return Array.isArray(field)
        ? field.some((value) => expectedValues.some((expectedItem) => isEqual(value, expectedItem)))
        : expectedValues.some((expectedItem) => isEqual(field, expectedItem));
    }
    case 'lt':
      return field != null && field < expectedValue;
    case 'lte':
      return field != null && field <= expectedValue;
    case 'ne':
      return !isEqual(field, expectedValue);
    case 'none':
      return Array.isArray(field) && !field.some((value) => matchesValue(value, expectedValue));
    case 'not':
      return !matchesValue(field, expectedValue);
    case 'some':
      return Array.isArray(field) && field.some((value) => matchesValue(value, expectedValue));
    case 'startsWith':
      return typeof field === 'string' && field.toLowerCase().startsWith(String(expectedValue).toLowerCase());
    default:
      return false;
  }
};

function matchesValue(field, condition) {
  if (!isObject(condition)) {
    return isEqual(field, condition);
  }

  const conditionEntries = Object.entries(condition);
  const operatorEntries = conditionEntries.filter(([operator]) => FIELD_OPERATORS.has(operator));
  const nestedEntries = conditionEntries.filter(([key]) => !FIELD_OPERATORS.has(key));

  if (!operatorEntries.every(([operator, expectedValue]) => matchesOperator(field, operator, expectedValue))) {
    return false;
  }

  if (nestedEntries.length === 0) {
    return true;
  }

  return isObject(field) && matchesWhere(field, Object.fromEntries(nestedEntries));
}

function matchesWhere(value, where) {
  if (!isObject(value) || !isObject(where)) {
    return false;
  }

  return Object.entries(where).every(([key, condition]) => {
    if (key === 'and') {
      return Array.isArray(condition) && condition.every((nestedWhere) => matchesWhere(value, nestedWhere));
    }

    if (key === 'or') {
      return Array.isArray(condition) && condition.length > 0 && condition.some((nestedWhere) => matchesWhere(value, nestedWhere));
    }

    if (key === 'not') {
      return isObject(condition) && !matchesWhere(value, condition);
    }

    return isSafeKey(key) && matchesValue(value[key], condition);
  });
}

const parsePrimitive = (value) => {
  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  if (value === 'null') {
    return null;
  }

  return value;
};

const parseFilterKey = (key) => {
  const colonIndex = key.lastIndexOf(':');

  if (colonIndex !== -1) {
    const path = key.slice(0, colonIndex);
    const operator = key.slice(colonIndex + 1);

    return FIELD_OPERATORS.has(operator) ? { operator, path } : undefined;
  }

  const legacyOperator = key.match(/^(.*)_([a-zA-Z]+)$/);

  if (legacyOperator?.[1] != null && legacyOperator[2] != null && FIELD_OPERATORS.has(legacyOperator[2])) {
    return { operator: legacyOperator[2], path: legacyOperator[1] };
  }

  return { operator: 'eq', path: key };
};

const setWhereOperator = (where, path, operator, value) => {
  const keys = path.split('.').filter(Boolean);

  if (keys.length === 0 || keys.some((key) => !isSafeKey(key))) {
    return;
  }

  const fieldKey = keys.pop();
  let currentValue = where;

  keys.forEach((key) => {
    currentValue[key] = isObject(currentValue[key]) ? currentValue[key] : {};
    currentValue = currentValue[key];
  });

  currentValue[fieldKey] = isObject(currentValue[fieldKey]) ? currentValue[fieldKey] : {};
  currentValue[fieldKey][operator] = operator === 'in' && typeof value === 'string' ? value.split(',').map((item) => parsePrimitive(item.trim())) : parsePrimitive(value);
};

const parseWhere = (query) => {
  const rawWhere = toArray(query._where).at(-1);

  if (rawWhere != null) {
    try {
      const where = JSON.parse(rawWhere);

      if (!isObject(where)) {
        throw new Error();
      }

      return where;
    } catch {
      throw createHttpError(400, 'Параметр _where должен содержать JSON-объект');
    }
  }

  const where = {};

  Object.entries(query).forEach(([key, rawValue]) => {
    if (RESERVED_QUERY_KEYS.has(key)) {
      return;
    }

    const filterKey = parseFilterKey(key);

    if (filterKey == null) {
      return;
    }

    toArray(rawValue).forEach((value) => setWhereOperator(where, filterKey.path, filterKey.operator, value));
  });

  return where;
};

const singularize = (value) => {
  if (value === 'clothes') {
    return value;
  }

  if (value.endsWith('ies')) {
    return `${value.slice(0, -3)}y`;
  }

  return value.endsWith('s') ? value.slice(0, -1) : value;
};

const getResourceNames = (database) => Object.entries(database.data).filter(([, value]) => Array.isArray(value)).map(([resource]) => resource);

const resolveResource = (database, relation, sourceResource) => {
  const resourceNames = getResourceNames(database);
  const resource = resourceNames.find((resourceName) => resourceName === relation) ?? resourceNames.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return ['child', 'children', 'parent', 'parents'].includes(relation) && resourceNames.includes(sourceResource) ? sourceResource : undefined;
};

const getRelationKeys = (...names) => [...new Set(names.flatMap((name) => [`${name}Id`, `${name}Ids`]))];

const findLocalRelation = (item, relation, targetResource) => {
  const relationKey = getRelationKeys(relation, singularize(relation), targetResource, singularize(targetResource)).find((key) => Object.hasOwn(item, key));

  if (relationKey == null) {
    return undefined;
  }

  return { ids: toArray(item[relationKey]).filter((id) => id != null), isMany: relationKey.endsWith('Ids') || Array.isArray(item[relationKey]) };
};

const hasReference = (value, relationKeys, id) => {
  if (Array.isArray(value)) {
    return value.some((item) => hasReference(item, relationKeys, id));
  }

  if (!isObject(value)) {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (!isSafeKey(key)) {
      return false;
    }

    if (relationKeys.includes(key)) {
      return toArray(nestedValue).some((nestedId) => isEqual(nestedId, id));
    }

    return hasReference(nestedValue, relationKeys, id);
  });
};

const findRelatedValue = (database, item, sourceResource, relation, targetResource) => {
  const targetItems = database.data[targetResource];
  const localRelation = findLocalRelation(item, relation, targetResource);

  if (!Array.isArray(targetItems)) {
    return undefined;
  }

  if (localRelation != null) {
    const relatedItems = localRelation.ids.map((id) => targetItems.find((targetItem) => isObject(targetItem) && isEqual(targetItem.id, id))).filter((targetItem) => targetItem != null);

    return localRelation.isMany ? relatedItems : relatedItems[0] ?? null;
  }

  if (item.id == null) {
    return undefined;
  }

  const reverseRelationKeys = getRelationKeys(singularize(sourceResource));

  if (relation === 'child' || relation === 'children') {
    reverseRelationKeys.push('parentId', 'parentIds');
  }

  return targetItems.filter((targetItem) => hasReference(targetItem, reverseRelationKeys, item.id));
};

const embedPath = (database, item, sourceResource, [relation, ...nestedRelations]) => {
  if (relation == null || !isSafeKey(relation)) {
    return item;
  }

  const currentValue = item[relation];
  const nestedSourceResource = resolveResource(database, relation, sourceResource) ?? relation;

  if (Array.isArray(currentValue)) {
    return nestedRelations.length === 0 ? item : { ...item, [relation]: currentValue.map((value) => (isObject(value) ? embedPath(database, value, nestedSourceResource, nestedRelations) : value)) };
  }

  if (isObject(currentValue)) {
    return nestedRelations.length === 0 ? item : { ...item, [relation]: embedPath(database, currentValue, nestedSourceResource, nestedRelations) };
  }

  const targetResource = resolveResource(database, relation, sourceResource);

  if (targetResource == null) {
    return item;
  }

  const relatedValue = findRelatedValue(database, item, sourceResource, relation, targetResource);

  if (relatedValue == null || nestedRelations.length === 0) {
    return relatedValue === undefined ? item : { ...item, [relation]: relatedValue };
  }

  return {
    ...item,
    [relation]: Array.isArray(relatedValue)
      ? relatedValue.map((value) => embedPath(database, value, targetResource, nestedRelations))
      : embedPath(database, relatedValue, targetResource, nestedRelations),
  };
};

const parseEmbedPaths = (embed) => toArray(embed)
  .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
  .map((path) => path.split('.').filter(Boolean))
  .filter((path) => path.length > 0 && path.every(isSafeKey));

const embedItem = (database, item, resource, embedPaths) => embedPaths.reduce((embeddedItem, path) => embedPath(database, embeddedItem, resource, path), item);

const sortItems = (items, sort) => {
  const sortRules = typeof sort === 'string' ? sort.split(',').filter(Boolean) : [];

  if (sortRules.length === 0) {
    return [...items];
  }

  return [...items].sort((left, right) => {
    for (const sortRule of sortRules) {
      const isDescending = sortRule.startsWith('-');
      const path = isDescending ? sortRule.slice(1) : sortRule;
      const comparison = compareValues(getValueByPath(left, path), getValueByPath(right, path));

      if (comparison !== 0) {
        return isDescending ? -comparison : comparison;
      }
    }

    return 0;
  });
};

const paginateItems = (items, page, pageSize) => {
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 10;
  const pages = Math.max(1, Math.ceil(items.length / safePageSize));
  const safePage = Math.max(1, Math.min(Number.isFinite(page) ? Math.floor(page) : 1, pages));
  const offset = (safePage - 1) * safePageSize;

  return {
    data: items.slice(offset, offset + safePageSize),
    first: 1,
    items: items.length,
    last: pages,
    next: safePage < pages ? safePage + 1 : null,
    pages,
    prev: safePage > 1 ? safePage - 1 : null,
  };
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
const resolveDatabasePath = (databasePath) => {
  if (typeof databasePath !== 'string' || databasePath === '') {
    throw new Error('Укажите путь к JSON-базе данных');
  }

  return resolve(databasePath);
};

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

  server.get('/', async() => ({ resources: getResourceNames(database) }));

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
    const itemIndex = collection.indexOf(currentItem);

    collection.splice(itemIndex, 1, item);
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
    const itemIndex = collection.indexOf(currentItem);

    collection.splice(itemIndex, 1, item);
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

const getCliOption = (argumentsList, ...names) => {
  const optionIndex = argumentsList.findIndex((argument) => names.includes(argument));

  return optionIndex === -1 ? undefined : argumentsList[optionIndex + 1];
};

const runCli = async() => {
  const [databaseArgument, ...cliArguments] = process.argv.slice(2);

  if (databaseArgument == null || databaseArgument.startsWith('-')) {
    throw new Error('Укажите путь к базе данных: deep-json-server database.json');
  }

  await startServer({
    databasePath: databaseArgument,
    host: getCliOption(cliArguments, '--host', '-h') ?? process.env.HOST ?? '127.0.0.1',
    port: Number(getCliOption(cliArguments, '--port', '-p') ?? process.env.PORT ?? 4001),
  });
};

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCli();
}
