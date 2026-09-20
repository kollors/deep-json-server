import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { isSystemError } from './utils.js';
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
  for (const [index, key] of outputKeys.entries()) if (inputKeys.includes(key)) throw new Error(`Schema export would overwrite an input file: ${outputs[index]}`);
}
