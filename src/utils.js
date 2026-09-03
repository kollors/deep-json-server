import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pluralize from 'pluralize';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const createHttpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

/** @returns {<T>(operation: () => T | Promise<T>) => Promise<T>} Serialized operation scheduler. */
export const createSerialQueue = () => {
  let queue = Promise.resolve();

  return (operation) => {
    const pendingOperation = queue.then(operation);

    // Keep the queue usable after a failed operation.
    queue = pendingOperation.catch(() => undefined);

    return pendingOperation;
  };
};

/**
 * Creates a random ID that is not currently in use.
 * @param {(id: string) => boolean} isUsed Checks whether an ID already exists.
 * @returns {string} Unique ID.
 */
export const createUniqueId = (isUsed) => {
  let id;

  do {
    id = randomBytes(8).toString('base64url');
  } while (isUsed(id));

  return id;
};

export const getResourceNames = (data) => Object.keys(data);
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isSafeKey = (key) => !UNSAFE_KEYS.has(key);
/**
 * @template T
 * @param {T | T[]} value A single value or an array.
 * @returns {T[]} The value represented as an array.
 */
export const toArray = (value) => (Array.isArray(value) ? value : [value]);

export const isEqual = (left, right) => {
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

export const resolveDatabasePath = (databasePath) => {
  if (typeof databasePath !== 'string' || databasePath === '') {
    throw new Error('Укажите путь к JSON-базе данных');
  }

  return resolve(databasePath);
};

export const isIdEqual = (left, right) => left != null && right != null && String(left) === String(right);
export const singularize = (value) => pluralize.singular(value);

export const toPascalCase = (value) =>
  value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join('');
