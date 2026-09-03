import { createDiskFileStore } from './disk-store.js';
import { createMemoryFileStore } from './memory-store.js';

/**
 * Creates a disk- or memory-backed file store.
 * @param {import('../config.js').FilesConfig} config File storage configuration.
 * @returns {Promise<import('./contract.js').FileStore>} File store.
 */
export const createFileStore = async (config) => ('data' in config ? createMemoryFileStore(config.data) : createDiskFileStore(config));

export { registerFileRoutes } from './routes.js';
