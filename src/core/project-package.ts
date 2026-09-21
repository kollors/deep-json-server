import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isObject } from './utils.js';

export interface ProjectPackage {
  name: string;
  version: string;
  description?: string;
}

/** Проверяет метаданные проекта и копирует поля, используемые генераторами схем. */
export function normalizeProjectPackage(value: unknown, label = 'package'): ProjectPackage {
  if (!isObject(value) || typeof value.name !== 'string' || value.name.length === 0 || typeof value.version !== 'string' || value.version.length === 0) {
    throw new Error(`${label} must contain non-empty name and version`);
  }
  if (value.description !== undefined && typeof value.description !== 'string') throw new Error(`${label}.description must be a string`);

  return { name: value.name, version: value.version, ...(value.description === undefined ? {} : { description: value.description }) };
}

/** Загружает package.json либо возвращает проверенную копию метаданных из памяти. */
export async function loadProjectPackage(source: string | ProjectPackage): Promise<ProjectPackage> {
  if (typeof source !== 'string') return normalizeProjectPackage(source, 'config.package.source');
  const path = resolve(source);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Cannot read package metadata from ${path}`, { cause: error });
  }
  return normalizeProjectPackage(value, path);
}
