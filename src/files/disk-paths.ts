import { access, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { domainError } from '../core/errors.js';
import { isSystemError } from '../core/utils.js';

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
};

const isPathInside = (rootPath: string, targetPath: string): boolean => {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
};

const assertRegularFile = (stats: { isFile(): boolean }): void => {
  if (!stats.isFile()) throw domainError('INVALID_INPUT', 'Path must point to a regular file');
};

/** Готовит и проверяет пути дискового хранилища, не выполняя операций с содержимым файлов.
 * @example resolveExistingPath('images/a.png') → абсолютный путь внутри directory.
 */
export async function createDiskPaths({ directory, metadata, staging, protectedPaths }: { directory: string; metadata: string; staging: string; protectedPaths: Set<string> }) {
  const realDirectory = await realpath(directory);
  const assertContained = (path: string): void => {
    if (!isPathInside(realDirectory, path)) throw domainError('INVALID_INPUT', 'File path escapes the storage directory');
  };
  const resolveFilePath = (path: string): string => {
    const filePath = resolve(directory, path);
    const canonical = resolve(realDirectory, relative(directory, filePath));
    if (protectedPaths.has(canonical)) throw domainError('INVALID_INPUT', 'Path is reserved for a server input file');
    if (filePath === directory || !isPathInside(directory, filePath) || filePath === metadata || isPathInside(staging, filePath))
      throw domainError('INVALID_INPUT', 'File path escapes the storage directory');
    return filePath;
  };
  const assertNoSymlinks = async (targetPath: string): Promise<void> => {
    const relativePath = relative(directory, targetPath);
    const parts = relativePath === '' ? [] : relativePath.split(sep);
    let currentPath = directory;
    for (const part of parts) {
      currentPath = resolve(currentPath, part);
      try {
        if ((await lstat(currentPath)).isSymbolicLink()) throw domainError('INVALID_INPUT', 'File path must not contain symbolic links');
      } catch (error) {
        if (!isSystemError(error) || error.code !== 'ENOENT') throw error;
      }
    }
  };
  const prepareTargetPath = async (path: string): Promise<string> => {
    const filePath = resolveFilePath(path);
    const targetDirectory = dirname(filePath);
    const parts = relative(directory, targetDirectory).split(sep).filter(Boolean);
    let currentPath = directory;
    for (const part of parts) {
      currentPath = resolve(currentPath, part);
      try {
        await mkdir(currentPath);
      } catch (error) {
        if (!isSystemError(error) || error.code !== 'EEXIST') throw error;
      }
      const currentStats = await lstat(currentPath);
      if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) throw domainError('INVALID_INPUT', 'File path must contain only regular directories');
      assertContained(await realpath(currentPath));
    }
    if (await pathExists(filePath)) {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
      assertRegularFile(await lstat(filePath));
    }
    return filePath;
  };
  const resolveExistingPath = async (path: string): Promise<string> => {
    const filePath = resolveFilePath(path);
    try {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
      assertRegularFile(await lstat(filePath));
    } catch (error) {
      if (isSystemError(error) && error.code === 'ENOENT') throw domainError('NOT_FOUND', 'File not found');
      throw error;
    }
    return filePath;
  };
  return { pathExists, prepareTargetPath, resolveExistingPath };
}
