import { resolve } from 'node:path';
import type { FileStore, FilesConfig } from './contract.js';
import { createDiskFileStore } from './disk-store.js';
import { createMemoryFileStore } from './memory-store.js';

/** Выбирает дисковое хранилище или хранилище в памяти по настройкам.
 * @example createFileStore({ source: [] }) → Promise<FileStore> без создания файлов на диске.
 */
export const createFileStore = async (config: FilesConfig, protectedPaths: string[] = []): Promise<FileStore> =>
  typeof config.source === 'string'
    ? createDiskFileStore({ directory: config.source, metadata: config.metadata ?? resolve(config.source, '.files.json'), protectedPaths })
    : createMemoryFileStore(config.source);

export { registerFileRoutes } from './routes.js';
