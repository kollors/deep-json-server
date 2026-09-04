import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JSONFilePreset } from 'lowdb/node';
import type { DatabaseConfig } from './config.js';
import type { DatabaseData, DatabaseRecord } from './types.js';
import { createHttpError, createSerialQueue, createUniqueId, isObject, isSafeKey, isSystemError, resolveDatabasePath } from './utils.js';

export interface DatabaseContainer {
  data: DatabaseData;
}
export interface DatabaseStore {
  database: DatabaseContainer;
  path?: string;
  read(): Promise<DatabaseData>;
  update<T>(operation: (database: DatabaseContainer) => T): Promise<T>;
}

const RESOURCE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

export const validateJsonValue = (value: unknown, path: string, ancestors = new WeakSet<object>()): void => {
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

  const prototype = Object.getPrototypeOf(value);

  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} должен содержать обычный JSON-объект`);
  }

  ancestors.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new Error(`${path}[${index}] отсутствует; разреженные массивы несовместимы с JSON`);
      }

      validateJsonValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    Object.entries(value).forEach(([key, item]) => {
      validateJsonValue(item, `${path}.${key}`, ancestors);
    });
  }

  ancestors.delete(value);
};

export const validateDatabase = (data: unknown): DatabaseData => {
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

  return data as DatabaseData;
};

export const readJsonObjectFile = async (path: string, label: string): Promise<Record<string, unknown>> => {
  const resolvedPath = resolve(path);
  let source: string;

  try {
    source = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      throw new Error(`${label} не найден: ${resolvedPath}`);
    }

    throw error;
  }

  const value = JSON.parse(source);

  if (!isObject(value)) {
    throw new Error(`${label} должен содержать JSON-объект`);
  }

  return value;
};

export const readDatabaseFile = async (databasePath: string): Promise<DatabaseData> => validateDatabase(await readJsonObjectFile(databasePath, 'Файл базы данных'));

const createDiskDatabaseStore = async (databasePath: string): Promise<DatabaseStore> => {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const initialData = await readDatabaseFile(resolvedDatabasePath);
  const database = await JSONFilePreset(resolvedDatabasePath, initialData);
  const schedule = createSerialQueue();

  const read = async () => {
    database.data = await readDatabaseFile(resolvedDatabasePath);

    return database.data;
  };

  const update = <T>(operation: (database: DatabaseContainer) => T): Promise<T> =>
    schedule(async () => {
      await read();

      const result = operation(database);

      validateDatabase(database.data);
      await database.write();

      return result;
    });

  return { database, path: resolvedDatabasePath, read, update };
};

const createMemoryDatabaseStore = (sourceData: DatabaseData): DatabaseStore => {
  validateDatabase(sourceData);

  const database = { data: structuredClone(sourceData) };
  const schedule = createSerialQueue();

  const read = async () => database.data;
  const update = <T>(operation: (database: DatabaseContainer) => T): Promise<T> =>
    schedule(() => {
      const draft = { data: structuredClone(database.data) };
      const result = operation(draft);

      validateDatabase(draft.data);
      database.data = draft.data;

      return result;
    });

  return { database, read, update };
};

/** Creates a disk- or memory-backed database with serialized updates. */
export const createDatabaseStore = async (config: DatabaseConfig): Promise<DatabaseStore> => (config.data != null ? createMemoryDatabaseStore(config.data) : createDiskDatabaseStore(config.path));

export const getCollection = (database: DatabaseContainer, resource: string): DatabaseRecord[] => {
  const collection = isSafeKey(resource) ? database.data[resource] : undefined;

  if (!Array.isArray(collection)) {
    throw createHttpError(404, 'Ресурс не найден');
  }

  return collection;
};

export const findItemIndex = (collection: DatabaseRecord[], id: unknown): number => collection.findIndex((item) => String(item.id) === String(id));

export const createId = (collection: DatabaseRecord[]): string => createUniqueId((id) => findItemIndex(collection, id) !== -1);
