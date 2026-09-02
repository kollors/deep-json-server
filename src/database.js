import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { createHttpError, isObject, isSafeKey, resolveDatabasePath } from './utils.js';

const RESOURCE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const validateDatabase = (data) => {
  if (!isObject(data)) {
    throw new Error('База данных должна содержать JSON-объект');
  }

  Object.entries(data).forEach(([resource, records]) => {
    if (!RESOURCE_NAME_PATTERN.test(resource) || !isSafeKey(resource)) {
      throw new Error(`Недопустимое имя ресурса «${resource}»`);
    }

    if (!Array.isArray(records)) {
      throw new Error(`Ресурс «${resource}» должен содержать JSON-массив`);
    }

    const ids = new Set();

    records.forEach((record, index) => {
      if (!isObject(record)) {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать JSON-объект`);
      }

      if (typeof record.id !== 'string' && !(typeof record.id === 'number' && Number.isFinite(record.id))) {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать строковый или числовой id`);
      }

      if (String(record.id) === '') {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать непустой id`);
      }

      const id = String(record.id);

      if (ids.has(id)) {
        throw new Error(`Ресурс «${resource}» содержит повторяющийся id «${id}»`);
      }

      ids.add(id);
    });
  });

  return data;
};

export const readJsonObject = async (path, label) => {
  let source;

  try {
    source = await readFile(resolve(path), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} не найден: ${resolve(path)}`);
    }

    throw error;
  }

  const value = JSON.parse(source);

  if (!isObject(value)) {
    throw new Error(`${label} должен содержать JSON-объект`);
  }

  return value;
};

export const readDatabaseFile = async (databasePath) => validateDatabase(await readJsonObject(databasePath, 'Файл базы данных'));

const createDiskDatabaseStore = async (databasePath) => {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const initialData = await readDatabaseFile(resolvedDatabasePath);
  const database = await JSONFilePreset(resolvedDatabasePath, initialData);
  let writeQueue = Promise.resolve();

  const read = async () => {
    database.data = await readDatabaseFile(resolvedDatabasePath);

    return database.data;
  };

  const update = (operation) => {
    const pendingOperation = writeQueue.then(async () => {
      await read();

      const result = operation(database);

      validateDatabase(database.data);
      await database.write();

      return result;
    });

    writeQueue = pendingOperation.catch(() => undefined);

    return pendingOperation;
  };

  return { database, path: resolvedDatabasePath, read, update };
};

const createMemoryDatabaseStore = (sourceData) => {
  const database = { data: validateDatabase(structuredClone(sourceData)) };
  let updateQueue = Promise.resolve();

  const read = async () => database.data;
  const update = (operation) => {
    const pendingOperation = updateQueue.then(() => {
      const draft = { data: structuredClone(database.data) };
      const result = operation(draft);

      validateDatabase(draft.data);
      database.data = draft.data;

      return result;
    });

    updateQueue = pendingOperation.catch(() => undefined);

    return pendingOperation;
  };

  return { database, read, update };
};

/**
 * @param {import('./config.js').DatabaseConfig} config Database source.
 * @returns {Promise<any>} Internal database store.
 */
export const createDatabaseStore = async (config) => ('data' in config ? createMemoryDatabaseStore(config.data) : createDiskDatabaseStore(config.path));

export const getCollection = (database, resource) => {
  const collection = isSafeKey(resource) ? database.data[resource] : undefined;

  if (!Array.isArray(collection)) {
    throw createHttpError(404, 'Ресурс не найден');
  }

  return collection;
};

export const findItem = (collection, id) => collection.find((item) => String(item.id) === String(id));

export const createId = (collection) => {
  let id;

  do {
    id = randomBytes(8).toString('base64url');
  } while (findItem(collection, id) != null);

  return id;
};
