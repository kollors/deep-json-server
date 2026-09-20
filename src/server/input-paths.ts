import { basename, dirname, resolve } from 'node:path';
import { isObject } from '../core/utils.js';
/** Собирает пути входных файлов, счётчиков и временных файлов записи без чтения диска.
 * @example auth.source = '/tmp/users.json' → среди защищённых путей '/tmp/users.json' и '/tmp/.users.json.tmp'.
 */
export function inputPaths(config: { database?: unknown; files?: unknown; auth?: unknown }, directory = '.', sourcePath?: string): string[] {
  const database = isObject(config.database) ? config.database : {};
  const files = isObject(config.files) ? config.files : {};
  const auth = isObject(config.auth) ? config.auth : {};
  const paths = [sourcePath, database.source, database.schema, files.metadata ?? (typeof files.source === 'string' ? resolve(directory, files.source, '.files.json') : undefined), auth.source].filter(
    (path): path is string => typeof path === 'string',
  );
  if (typeof database.source === 'string') paths.push(`${database.source}.counters.json`);
  // JSONFile использует эти соседние файлы при записи; они тоже содержат защищённые данные.
  for (const path of [database.source, typeof database.source === 'string' ? `${database.source}.counters.json` : undefined, auth.source])
    if (typeof path === 'string') paths.push(resolve(directory, dirname(path), `.${basename(path)}.tmp`));
  return paths.map((path) => resolve(directory, path));
}
