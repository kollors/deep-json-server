import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import { createHttpError, createSerialQueue, createUniqueId, isObject, isSafeKey, resolveDatabasePath } from './utils.js';

/** @typedef {{ data: import('./config.js').DatabaseData }} DatabaseContainer */
/**
 * @typedef {object} DatabaseStore
 * @property {DatabaseContainer} database Current database container.
 * @property {string} [path] Resolved database file path.
 * @property {() => Promise<import('./config.js').DatabaseData>} read Returns current data and reloads disk-backed sources.
 * @property {<T>(operation: (database: DatabaseContainer) => T) => Promise<T>} update Runs a serialized update.
 */

const RESOURCE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

const validateJsonValue = (value, path, ancestors = new WeakSet()) => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${path} должен содержать конечное число`);
    }

    return;
  }

  if (typeof value !== 'object') {
    throw new Error(`${path} содержит значение, несовместимое с JSON`);
  }

  if (ancestors.has(value)) {
    throw new Error(`${path} содержит циклическую ссылку`);
  }

  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new Error(`${path} должен содержать обычный JSON-объект`);
  }

  ancestors.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      validateJsonValue(item, `${path}[${index}]`, ancestors);
    });
  } else {
    Object.entries(value).forEach(([key, item]) => {
      validateJsonValue(item, `${path}.${key}`, ancestors);
    });
  }

  ancestors.delete(value);
};

export const validateDatabase = (data) => {
  if (!isObject(data)) {
    throw new Error('База данных должна содержать JSON-объект');
  }

  validateJsonValue(data, 'База данных');

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

export const readJsonObjectFile = async (path, label) => {
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

export const readDatabaseFile = async (databasePath) => validateDatabase(await readJsonObjectFile(databasePath, 'Файл базы данных'));

const createDiskDatabaseStore = async (databasePath) => {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const initialData = await readDatabaseFile(resolvedDatabasePath);
  const database = await JSONFilePreset(resolvedDatabasePath, initialData);
  const schedule = createSerialQueue();

  const read = async () => {
    database.data = await readDatabaseFile(resolvedDatabasePath);

    return database.data;
  };

  const update = (operation) =>
    schedule(async () => {
      await read();

      const result = operation(database);

      validateDatabase(database.data);
      await database.write();

      return result;
    });

  return { database, path: resolvedDatabasePath, read, update };
};

const createMemoryDatabaseStore = (sourceData) => {
  validateDatabase(sourceData);

  const database = { data: structuredClone(sourceData) };
  const schedule = createSerialQueue();

  const read = async () => database.data;
  const update = (operation) =>
    schedule(() => {
      const draft = { data: structuredClone(database.data) };
      const result = operation(draft);

      validateDatabase(draft.data);
      database.data = draft.data;

      return result;
    });

  return { database, read, update };
};

/**
 * Creates a disk- or memory-backed database with serialized updates.
 * @param {import('./config.js').DatabaseConfig} config Database source.
 * @returns {Promise<DatabaseStore>} Database store.
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

export const createId = (collection) => createUniqueId((id) => findItem(collection, id) != null);
