import type { FilesConfig } from '../config.js';
import type { FileStore } from './contract.js';
import { createDiskFileStore } from './disk-store.js';
import { createMemoryFileStore } from './memory-store.js';

/** Creates a disk- or memory-backed file store. */
export const createFileStore = async (config: FilesConfig): Promise<FileStore> => (config.data != null ? createMemoryFileStore(config.data) : createDiskFileStore(config));

export { registerFileRoutes } from './routes.js';
