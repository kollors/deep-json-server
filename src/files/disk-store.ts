import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHttpError, createSerialQueue, isSystemError } from '../utils.js';
import { type FileRecord, type FileStore, type FileUpdate, type FileUpload, getFileKey, normalizeStoredFileMetadata, type StoredFileMetadata } from './contract.js';

const createSizeLimiter = (maxFileSize: number, onSize: (size: number) => void): Transform => {
  let size = 0;

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      size += chunk.length;

      if (size > maxFileSize) {
        callback(createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`));
        return;
      }

      onSize(size);
      callback(null, chunk);
    },
  });
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

const isPathInside = (rootPath: string, targetPath: string): boolean => {
  const relativePath = relative(rootPath, targetPath);

  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
};

const readMetadata = async (metadataPath: string): Promise<Map<string, StoredFileMetadata>> => {
  let source: unknown;

  try {
    source = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      return new Map();
    }

    throw error;
  }

  if (!Array.isArray(source)) {
    throw new Error(`Файл метаданных ${metadataPath} должен содержать JSON-массив`);
  }

  const files = new Map<string, StoredFileMetadata>();

  source.forEach((value, index) => {
    const file = normalizeStoredFileMetadata(value, `Запись ${index} в файле метаданных ${metadataPath}`);
    const path = getFileKey(file);

    if (files.has(path)) {
      throw new Error(`Файл метаданных ${metadataPath} содержит повторяющийся путь «${path}»`);
    }

    files.set(path, file);
  });

  return files;
};

const writeMetadata = async (metadataPath: string, files: Map<string, StoredFileMetadata>): Promise<void> => {
  const temporaryPath = `${metadataPath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await writeFile(temporaryPath, JSON.stringify([...files.values()], null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const getFileSize = async (path: string): Promise<number> => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      throw createHttpError(404, 'Файл не найден');
    }

    throw error;
  }
};

export const createDiskFileStore = async ({ directory: sourceDirectoryPath, metadata: sourceMetadataPath }: { directory: string; metadata: string }): Promise<FileStore> => {
  const directoryPath = resolve(sourceDirectoryPath);
  const metadataPath = resolve(sourceMetadataPath);
  const stagingPath = resolve(directoryPath, '.deep-json-server');
  const schedule = createSerialQueue();
  const pendingCleanup = new Set<string>();

  await Promise.all([mkdir(directoryPath, { recursive: true }), mkdir(dirname(metadataPath), { recursive: true }), mkdir(stagingPath, { recursive: true })]);

  const realDirectoryPath = await realpath(directoryPath);
  let files = await readMetadata(metadataPath);

  const commitMetadata = async (nextFiles: Map<string, StoredFileMetadata>, rollback: () => Promise<void>, rollbackMessage: string): Promise<void> => {
    try {
      await writeMetadata(metadataPath, nextFiles);
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], rollbackMessage);
      }

      throw error;
    }

    files = nextFiles;
  };

  const assertContained = (path: string): void => {
    if (!isPathInside(realDirectoryPath, path)) {
      throw createHttpError(400, 'Путь файла выходит за пределы директории хранения');
    }
  };

  const resolveFilePath = (path: string): string => {
    const filePath = resolve(directoryPath, path);
    if (filePath === directoryPath || !isPathInside(directoryPath, filePath) || filePath === metadataPath || isPathInside(stagingPath, filePath)) {
      throw createHttpError(400, 'Путь файла выходит за пределы директории хранения');
    }

    return filePath;
  };

  const assertNoSymlinks = async (targetPath: string): Promise<void> => {
    const relativePath = relative(directoryPath, targetPath);
    const parts = relativePath === '' ? [] : relativePath.split(sep);
    let currentPath = directoryPath;

    for (const part of parts) {
      currentPath = resolve(currentPath, part);

      try {
        if ((await lstat(currentPath)).isSymbolicLink()) {
          throw createHttpError(400, 'Путь файла не должен содержать символические ссылки');
        }
      } catch (error) {
        if (!isSystemError(error) || error.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  };

  const prepareTargetPath = async (path: string): Promise<string> => {
    const filePath = resolveFilePath(path);
    const targetDirectory = dirname(filePath);
    const parts = relative(directoryPath, targetDirectory).split(sep).filter(Boolean);
    let currentPath = directoryPath;

    for (const part of parts) {
      currentPath = resolve(currentPath, part);

      try {
        await mkdir(currentPath);
      } catch (error) {
        if (!isSystemError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }

      const currentStats = await lstat(currentPath);

      if (currentStats.isSymbolicLink() || !currentStats.isDirectory()) {
        throw createHttpError(400, 'Путь файла должен содержать только обычные директории');
      }

      assertContained(await realpath(currentPath));
    }

    if (await pathExists(filePath)) {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
    }

    return filePath;
  };

  const resolveExistingPath = async (path: string): Promise<string> => {
    const filePath = resolveFilePath(path);

    try {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
    } catch (error) {
      if (isSystemError(error) && error.code === 'ENOENT') {
        throw createHttpError(404, 'Файл не найден');
      }

      throw error;
    }

    return filePath;
  };

  const cleanupLater = async (path: string): Promise<void> => {
    try {
      await rm(path, { force: true });
      pendingCleanup.delete(path);
    } catch {
      pendingCleanup.add(path);
    }
  };

  const flushCleanup = async (): Promise<void> => {
    await Promise.all([...pendingCleanup].map(cleanupLater));
  };

  const findFile = (path: string): StoredFileMetadata => {
    const file = files.get(path);

    if (file == null) {
      throw createHttpError(404, 'Файл не найден');
    }

    return file;
  };

  const metadata = async (path: string): Promise<FileRecord> => {
    const file = findFile(path);
    const filePath = await resolveExistingPath(path);

    return { ...file, size: await getFileSize(filePath) };
  };

  const get = async (path: string): ReturnType<FileStore['get']> => {
    const file = findFile(path);
    const filePath = await resolveExistingPath(path);
    const handle = await open(filePath, 'r');

    try {
      const size = (await handle.stat()).size;

      return { file: { ...file, size }, stream: handle.createReadStream() };
    } catch (error) {
      await handle.close();
      throw error;
    }
  };

  const upload = async ({ directory, maxFileSize, mimeType, name, override, stream }: FileUpload): ReturnType<FileStore['upload']> => {
    const storedFile = { directory, mimeType, name };
    const key = getFileKey(storedFile);

    if (files.has(key) && !override) {
      throw createHttpError(409, 'Файл уже существует');
    }

    const stagedPath = resolve(stagingPath, `${randomBytes(12).toString('hex')}.upload`);
    let size = 0;

    try {
      await pipeline(
        stream,
        createSizeLimiter(maxFileSize, (value) => {
          size = value;
        }),
        createWriteStream(stagedPath, { flags: 'wx' }),
      );

      return await schedule(async () => {
        await flushCleanup();

        const path = await prepareTargetPath(key);
        const existsOnDisk = await pathExists(path);
        const exists = files.has(key) || existsOnDisk;

        if (exists && !override) {
          throw createHttpError(409, 'Файл уже существует');
        }

        const backupPath = `${path}.${randomBytes(6).toString('hex')}.backup`;
        let backedUp = false;
        let installed = false;
        let committed = false;

        try {
          if (existsOnDisk) {
            await rename(path, backupPath);
            backedUp = true;
          }

          await rename(stagedPath, path);
          installed = true;

          const nextFiles = new Map(files);

          nextFiles.set(key, storedFile);
          await writeMetadata(metadataPath, nextFiles);
          files = nextFiles;
          committed = true;

          return { created: !exists, file: { ...storedFile, size } };
        } catch (error) {
          const rollbackErrors: unknown[] = [];

          if (installed) {
            await rm(path, { force: true }).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
          }

          if (backedUp) {
            await rename(backupPath, path).catch((rollbackError: unknown) => rollbackErrors.push(rollbackError));
          }

          if (rollbackErrors.length > 0) {
            throw new AggregateError([error, ...rollbackErrors], 'Не удалось сохранить файл и полностью откатить операцию');
          }

          throw error;
        } finally {
          if (committed && backedUp) {
            await cleanupLater(backupPath);
          }
        }
      });
    } finally {
      await cleanupLater(stagedPath);
    }
  };

  const update = (sourcePath: string, updates: FileUpdate): ReturnType<FileStore['update']> =>
    schedule(async () => {
      await flushCleanup();

      const file = findFile(sourcePath);
      const updatedFile = { ...file, ...updates };
      const targetPath = getFileKey(updatedFile);
      const sourceFilePath = await resolveExistingPath(sourcePath);

      if (sourcePath === targetPath) {
        return { ...file, size: await getFileSize(sourceFilePath) };
      }

      const targetFilePath = await prepareTargetPath(targetPath);

      if (files.has(targetPath) || (await pathExists(targetFilePath))) {
        throw createHttpError(409, 'Файл с таким путём уже существует');
      }

      await rename(sourceFilePath, targetFilePath);

      const nextFiles = new Map(files);

      nextFiles.delete(sourcePath);
      nextFiles.set(targetPath, updatedFile);

      await commitMetadata(nextFiles, () => rename(targetFilePath, sourceFilePath), 'Не удалось обновить файл и откатить перемещение');

      return { ...updatedFile, size: await getFileSize(targetFilePath) };
    });

  const remove = (path: string): ReturnType<FileStore['remove']> =>
    schedule(async () => {
      await flushCleanup();
      findFile(path);

      const filePath = await resolveExistingPath(path);
      const temporaryPath = `${filePath}.${randomBytes(6).toString('hex')}.delete`;

      await rename(filePath, temporaryPath);

      const nextFiles = new Map(files);

      nextFiles.delete(path);

      await commitMetadata(nextFiles, () => rename(temporaryPath, filePath), 'Не удалось удалить файл и откатить операцию');
      await cleanupLater(temporaryPath);
    });

  return { get, metadata, remove, update, upload };
};
