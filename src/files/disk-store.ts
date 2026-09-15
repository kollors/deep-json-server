import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { domainError } from '../core/errors.js';
import { canonicalPath } from '../core/paths.js';
import { createSerialQueue, isSystemError } from '../core/utils.js';
import { type FileRecord, type FileStore, type FileUpdate, type FileUpload, getFileKey, type StoredFileMetadata } from './contract.js';
import { readDiskMetadata, writeDiskMetadata } from './disk-metadata.js';
import { createDiskPaths } from './disk-paths.js';
import { createSizeLimiter } from './streams.js';

/** Читает размер обычного файла; отсутствие или неподходящий тип пути превращает в ошибку.
 * @example Файл из трёх байтов → Promise<3>.
 */
const getFileSize = async (path: string): Promise<number> => {
  try {
    const stats = await stat(path);

    if (!stats.isFile()) throw domainError('INVALID_INPUT', 'Путь должен указывать на обычный файл');
    return stats.size;
  } catch (error) {
    if (isSystemError(error) && error.code === 'ENOENT') {
      throw domainError('NOT_FOUND', 'Файл не найден');
    }

    throw error;
  }
};

/** Открывает дисковое хранилище с проверками путей, защитой входных файлов и последовательными изменениями.
 * @example Каталог и файл метаданных → Promise<FileStore>; операции сохраняют байты и метаданные на диске.
 */
export const createDiskFileStore = async ({
  directory: sourceDirectoryPath,
  metadata: sourceMetadataPath,
  protectedPaths = [],
}: {
  directory: string;
  metadata: string;
  protectedPaths?: string[];
}): Promise<FileStore> => {
  const directoryPath = resolve(sourceDirectoryPath);
  const metadataPath = resolve(sourceMetadataPath);
  const stagingPath = resolve(directoryPath, '.deep-json-server');
  const protectedFiles = new Set(await Promise.all(protectedPaths.map(canonicalPath)));
  const canonicalMetadataPath = await canonicalPath(metadataPath);
  if (protectedFiles.has(canonicalMetadataPath)) throw new Error('File metadata must not overwrite a protected input file');
  protectedFiles.add(canonicalMetadataPath);
  const schedule = createSerialQueue();
  const pendingCleanup = new Set<string>();

  await Promise.all([mkdir(directoryPath, { recursive: true }), mkdir(dirname(metadataPath), { recursive: true }), mkdir(stagingPath, { recursive: true })]);

  const paths = await createDiskPaths({ directory: directoryPath, metadata: metadataPath, staging: stagingPath, protectedPaths: protectedFiles });
  let files = await readDiskMetadata(metadataPath);

  const commitMetadata = async (nextFiles: Map<string, StoredFileMetadata>, rollback: () => Promise<void>, rollbackMessage: string): Promise<void> => {
    try {
      await writeDiskMetadata(metadataPath, nextFiles);
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
      throw domainError('NOT_FOUND', 'Файл не найден');
    }

    return file;
  };

  const metadata = (path: string): Promise<FileRecord> =>
    schedule(async () => {
      const file = findFile(path);
      const filePath = await paths.resolveExistingPath(path);

      return { ...file, size: await getFileSize(filePath) };
    });

  const get = (path: string): ReturnType<FileStore['get']> =>
    schedule(async () => {
      const file = findFile(path);
      const filePath = await paths.resolveExistingPath(path);
      const handle = await open(filePath, 'r');

      try {
        const stats = await handle.stat();

        if (!stats.isFile()) throw domainError('INVALID_INPUT', 'Путь должен указывать на обычный файл');
        const size = stats.size;

        return { file: { ...file, size }, stream: handle.createReadStream() };
      } catch (error) {
        await handle.close();
        throw error;
      }
    });

  const upload = async ({ directory, maxFileSize, mimeType, name, override, stream }: FileUpload): ReturnType<FileStore['upload']> => {
    const storedFile = { directory, mimeType, name };
    const key = getFileKey(storedFile);

    if (files.has(key) && !override) {
      throw domainError('CONFLICT', 'Файл уже существует');
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

        const path = await paths.prepareTargetPath(key);
        const existsOnDisk = await paths.pathExists(path);
        const exists = files.has(key) || existsOnDisk;

        if (exists && !override) {
          throw domainError('CONFLICT', 'Файл уже существует');
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
          await writeDiskMetadata(metadataPath, nextFiles);
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
      const sourceFilePath = await paths.resolveExistingPath(sourcePath);

      if (sourcePath === targetPath) {
        return { ...file, size: await getFileSize(sourceFilePath) };
      }

      const targetFilePath = await paths.prepareTargetPath(targetPath);

      if (files.has(targetPath) || (await paths.pathExists(targetFilePath))) {
        throw domainError('CONFLICT', 'Файл с таким путём уже существует');
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

      const filePath = await paths.resolveExistingPath(path);
      const temporaryPath = `${filePath}.${randomBytes(6).toString('hex')}.delete`;

      await rename(filePath, temporaryPath);

      const nextFiles = new Map(files);

      nextFiles.delete(path);

      await commitMetadata(nextFiles, () => rename(temporaryPath, filePath), 'Не удалось удалить файл и откатить операцию');
      await cleanupLater(temporaryPath);
    });

  return { get, metadata, remove, update, upload };
};
