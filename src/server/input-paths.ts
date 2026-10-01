import { basename, dirname, resolve } from 'node:path';
import { canonicalEntryPath, canonicalPath } from '../core/paths.js';
import { isObject } from '../core/utils.js';
import { databaseLockPath } from './storage-lock.js';

/** Возвращает дисковые источники, совместное использование которых требует блокировки. */
export function writablePaths(config: { database?: unknown; files?: unknown; auth?: unknown }, directory = '.'): string[] {
  const database = isObject(config.database) ? config.database : {};
  const files = isObject(config.files) ? config.files : {};
  const auth = isObject(config.auth) ? config.auth : {};
  return [database.source, auth.source, files.source, files.metadata ?? (typeof files.source === 'string' ? resolve(directory, files.source, '.files.json') : undefined)]
    .filter((path): path is string => typeof path === 'string')
    .map((path) => resolve(directory, path));
}
/** Собирает пути входных файлов, счётчиков и временных файлов записи без чтения диска.
 * @example auth.source = '/tmp/users.json' → среди защищённых путей '/tmp/users.json' и '/tmp/.users.json.tmp'.
 */
export function inputPaths(config: { database?: unknown; files?: unknown; auth?: unknown; package?: unknown }, directory = '.', sourcePath?: string, includeLocks = true): string[] {
  const database = isObject(config.database) ? config.database : {};
  const files = isObject(config.files) ? config.files : {};
  const auth = isObject(config.auth) ? config.auth : {};
  const projectPackage = isObject(config.package) ? config.package : {};
  const paths = [
    sourcePath,
    database.source,
    database.schema,
    files.metadata ?? (typeof files.source === 'string' ? resolve(directory, files.source, '.files.json') : undefined),
    auth.source,
    projectPackage.source,
  ].filter((path): path is string => typeof path === 'string');
  if (typeof database.source === 'string') {
    paths.push(`${database.source}.counters.json`);
  }
  if (includeLocks) paths.push(...writablePaths(config, directory).map(databaseLockPath));
  // JSONFile использует эти соседние файлы при записи; они тоже содержат защищённые данные.
  for (const path of [database.source, typeof database.source === 'string' ? `${database.source}.counters.json` : undefined, auth.source])
    if (typeof path === 'string') paths.push(resolve(directory, dirname(path), `.${basename(path)}.tmp`));
  return paths.map((path) => resolve(directory, path));
}

/** Дополняет защиту экспорта файлами блокировок целей символических ссылок. */
export async function protectedInputPaths(config: { database?: unknown; files?: unknown; auth?: unknown; package?: unknown }, directory = '.', sourcePath?: string): Promise<string[]> {
  const sources = await Promise.all(writablePaths(config, directory).map((path) => Promise.all([canonicalEntryPath(path), canonicalPath(path)])));
  return [...inputPaths(config, directory, sourcePath), ...sources.flat().map(databaseLockPath)];
}
