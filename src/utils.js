import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pluralize from 'pluralize';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export const createHttpError = (statusCode, message) => {
  const error = new Error(message);

  error.statusCode = statusCode;

  return error;
};

export const getResourceNames = (data) => Object.entries(data).filter(([, value]) => Array.isArray(value)).map(([resource]) => resource);
export const isMainModule = (filePath, moduleUrl) => filePath != null && realpathSync(resolve(filePath)) === fileURLToPath(moduleUrl);
export const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
export const isSafeKey = (key) => !UNSAFE_KEYS.has(key);
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

export const singularize = (value) => pluralize.singular(value);

export const toPascalCase = (value) => value.split(/[^a-zA-Z0-9]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join('');
