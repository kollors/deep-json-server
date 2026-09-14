import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { isObject, isSystemError } from './utils.js';
/** Раскрывает символические ссылки в существующей части пути и сохраняет ещё не созданный остаток.
 * @example Если /tmp/link указывает на /data: /tmp/link/new.json → /data/new.json.
 */
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if (!isSystemError(error) || error.code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return resolve(await canonicalPath(parent), basename(absolute));
  }
}
/** Собирает пути входных файлов, счётчиков и временных файлов записи без чтения диска.
 * @example auth.source = '/tmp/users.json' → среди защищённых путей '/tmp/users.json' и '/tmp/.users.json.tmp'.
 */
export function inputPaths(config: { database?: unknown; files?: unknown; auth?: unknown }, directory = '.', sourcePath?: string): string[] {
  const database = isObject(config.database) ? config.database : {};
  const files = isObject(config.files) ? config.files : {};
  const auth = isObject(config.auth) ? config.auth : {};
  const paths = [
    sourcePath,
    database.source,
    database.schema,
    files.metadata ?? (typeof files.source === 'string' ? resolve(directory, files.source, '.files.json') : undefined),
    auth.source,
  ].filter((path): path is string => typeof path === 'string');
  if (typeof database.source === 'string') paths.push(`${database.source}.counters.json`);
  // JSONFile использует эти соседние файлы при записи; они тоже содержат защищённые данные.
  for (const path of [database.source, typeof database.source === 'string' ? `${database.source}.counters.json` : undefined, auth.source])
    if (typeof path === 'string') paths.push(resolve(directory, dirname(path), `.${basename(path)}.tmp`));
  return paths.map((path) => resolve(directory, path));
}
/** Читает идентификатор файла из устройства и inode; для отсутствующего файла возвращает исходный путь.
 * @example Существующий файл → строка dev:ino; отсутствующий /tmp/new → /tmp/new.
 */
async function identity(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if (!isSystemError(error) || error.code !== 'ENOENT') throw error;
    return path;
  }
}
/** Проверяет по реальным путям и inode, что выходные файлы различны и не совпадают с входными.
 * @example outputs = ['/tmp/a'], inputs = ['/tmp/a'] → ошибка; разные свободные пути → Promise<void>.
 */
export async function validateExportPaths(outputs: string[], inputs: string[]): Promise<void> {
  const canonicalOutputs = await Promise.all(outputs.map(canonicalPath));
  const canonicalInputs = await Promise.all(inputs.map(canonicalPath));
  const [outputKeys, inputKeys] = await Promise.all([Promise.all(canonicalOutputs.map(identity)), Promise.all(canonicalInputs.map(identity))]);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error('Schema export destinations must be different');
  for (let index = 0; index < outputKeys.length; index++) if (inputKeys.includes(outputKeys[index])) throw new Error(`Schema export would overwrite an input file: ${outputs[index]}`);
}
