import { realpath, stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { isObject, isSystemError } from './utils.js';
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
export function inputPaths(config: { database?: unknown; files?: unknown; auth?: unknown }, directory = '.', sourcePath?: string): string[] {
  const database = isObject(config.database) ? config.database : {};
  const files = isObject(config.files) ? config.files : {};
  const auth = isObject(config.auth) ? config.auth : {};
  const paths = [sourcePath, database.path, database.schema, files.metadata, auth.users].filter((path): path is string => typeof path === 'string');
  if (typeof database.path === 'string') paths.push(`${database.path}.counters.json`);
  return paths.map((path) => resolve(directory, path));
}
async function identity(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if (!isSystemError(error) || error.code !== 'ENOENT') throw error;
    return path;
  }
}
export async function validateExportPaths(outputs: string[], inputs: string[]): Promise<void> {
  const canonicalOutputs = await Promise.all(outputs.map(canonicalPath));
  const canonicalInputs = await Promise.all(inputs.map(canonicalPath));
  const [outputKeys, inputKeys] = await Promise.all([Promise.all(canonicalOutputs.map(identity)), Promise.all(canonicalInputs.map(identity))]);
  if (new Set(outputKeys).size !== outputKeys.length) throw new Error('Schema export destinations must be different');
  for (let index = 0; index < outputKeys.length; index++) if (inputKeys.includes(outputKeys[index])) throw new Error(`Schema export would overwrite an input file: ${outputs[index]}`);
}
