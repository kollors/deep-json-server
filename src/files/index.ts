import type { FileStore, FilesConfig } from './contract.js';
import { createDiskFileStore } from './disk-store.js';
import { createMemoryFileStore } from './memory-store.js';

/** Выбирает дисковое хранилище или хранилище в памяти по настройкам.
 * @example createFileStore({ data: [] }) → Promise<FileStore> без создания файлов на диске.
 */
export const createFileStore = async (config: FilesConfig, protectedPaths: string[] = []): Promise<FileStore> =>
  config.data != null ? createMemoryFileStore(config.data) : createDiskFileStore({ ...config, protectedPaths });

export { registerFileRoutes } from './routes.js';
