import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import type { DatabaseConfig } from './config.js';
import { domainError } from './errors.js';
import type { DatabaseData, DatabaseRecord } from './types.js';
import { createSerialQueue, createUniqueId, isObject, isSafeKey, isSystemError, resolveDatabasePath } from './utils.js';

export interface DatabaseContainer {
  data: DatabaseData;
  counters?: Record<string, number>;
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

export const validateDatabase = (data: unknown, primaryKeys?: Map<string, string>): DatabaseData => {
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

    const primary = primaryKeys?.get(resource) ?? 'id';
    const ids = new Set();

    records.forEach((record, index) => {
      if (!isObject(record)) {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать JSON-объект`);
      }

      if (typeof record[primary] !== 'string' && !(typeof record[primary] === 'number' && Number.isFinite(record[primary]))) {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать строковый или числовой id`);
      }

      if (String(record[primary]) === '') {
        throw new Error(`Запись ${index} ресурса «${resource}» должна содержать непустой id`);
      }

      const id = String(record[primary]);

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

export const readDatabaseFile = async (databasePath: string, keys?: Map<string, string>): Promise<DatabaseData> => validateDatabase(await readJsonObjectFile(databasePath, 'Файл базы данных'), keys);

const validateDraft = (data: DatabaseData, keys?: Map<string, string>): void => {
  try {
    validateDatabase(data, keys);
  } catch (error) {
    throw domainError('INVALID_INPUT', (error as Error).message);
  }
};

const createDiskDatabaseStore = async (databasePath: string, keys?: Map<string, string>): Promise<DatabaseStore> => {
  const resolvedDatabasePath = resolveDatabasePath(databasePath);
  const initialData = await readDatabaseFile(resolvedDatabasePath, keys);
  const database = new Low(new JSONFile<DatabaseData>(resolvedDatabasePath), initialData);
  const schedule = createSerialQueue();
  const counterStore = new Low(new JSONFile<Record<string, number>>(`${resolvedDatabasePath}.counters.json`), {});
  await counterStore.read();

  const read = async () => {
    database.data = await readDatabaseFile(resolvedDatabasePath, keys);

    return database.data;
  };

  const update = <T>(operation: (database: DatabaseContainer) => T): Promise<T> =>
    schedule(async () => {
      await read();

      await counterStore.read();
      const draft = { data: structuredClone(database.data), counters: structuredClone(counterStore.data) };
      const result = operation(draft);
      validateDraft(draft.data, keys);
      // Reserve generated numbers first: failed data writes may leave gaps, never reused IDs.
      if (JSON.stringify(draft.counters) !== JSON.stringify(counterStore.data)) {
        counterStore.data = draft.counters;
        await counterStore.write();
      }
      await database.adapter.write(draft.data);
      database.data = draft.data;

      return result;
    });

  return { database, path: resolvedDatabasePath, read, update };
};

const createMemoryDatabaseStore = (sourceData: DatabaseData, keys?: Map<string, string>): DatabaseStore => {
  validateDatabase(sourceData, keys);

  const database = { data: structuredClone(sourceData), counters: {} as Record<string, number> };
  const schedule = createSerialQueue();

  const read = async () => database.data;
  const update = <T>(operation: (database: DatabaseContainer) => T): Promise<T> =>
    schedule(() => {
      const draft = structuredClone(database);
      const result = operation(draft);

      validateDraft(draft.data, keys);
      database.data = draft.data;
      database.counters = draft.counters;

      return result;
    });

  return { database, read, update };
};

/** Creates a disk- or memory-backed database with serialized updates. */
export const createDatabaseStore = async (config: DatabaseConfig, keys?: Map<string, string>): Promise<DatabaseStore> =>
  config.data != null ? createMemoryDatabaseStore(config.data, keys) : createDiskDatabaseStore(config.path, keys);

export const findItemIndex = (collection: DatabaseRecord[], id: unknown): number => collection.findIndex((item) => String(item.id) === String(id));

export const createId = (collection: DatabaseRecord[]): string => createUniqueId((id) => findItemIndex(collection, id) !== -1);
