import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pluralize from 'pluralize';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface HttpError extends Error {
  statusCode: number;
}

export const assertKnownKeys = (value: object, keys: Set<string>, path: string): void => {
  const unknownKey = Object.keys(value).find((key) => !keys.has(key));

  if (unknownKey != null) {
    throw new Error(`Неизвестный ключ ${path}.${unknownKey}`);
  }
};

export const createHttpError = (statusCode: number, message: string): HttpError => Object.assign(new Error(message), { statusCode });

/** Creates a scheduler that runs mutations sequentially. */
export const createSerialQueue = () => {
  let queue: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T> | T): Promise<T> => {
    const pendingOperation = queue.then(operation);

    // Keep the queue usable after a failed operation.
    queue = pendingOperation.catch(() => undefined);

    return pendingOperation;
  };
};

/** Creates a random ID that is not currently in use. */
export const createUniqueId = (isUsed: (id: string) => boolean): string => {
  let id: string;

  do {
    id = randomBytes(8).toString('base64url');
  } while (isUsed(id));

  return id;
};

export const getResourceNames = (data: object): string[] => Object.keys(data);
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isSafeKey = (key: string): boolean => !UNSAFE_KEYS.has(key);
export const isSystemError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && 'code' in error;
/** Converts a single value or an array to an array. */
export const toArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

export const isEqual = (left: unknown, right: unknown): boolean => {
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

export const resolveDatabasePath = (databasePath: string): string => {
  if (typeof databasePath !== 'string' || databasePath === '') {
    throw new Error('Укажите путь к JSON-базе данных');
  }

  return resolve(databasePath);
};

export const isIdEqual = (left: unknown, right: unknown): boolean => left != null && right != null && String(left) === String(right);
export const singularize = (value: string): string => pluralize.singular(value);

export const toPascalCase = (value: string): string =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
