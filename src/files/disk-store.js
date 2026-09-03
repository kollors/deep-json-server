import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, lstat, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHttpError, createSerialQueue } from '../utils.js';
import { getFileKey, normalizeStoredFileMetadata } from './contract.js';

const createSizeLimiter = (maxFileSize, onSize) => {
  let size = 0;

  return new Transform({
    transform(chunk, _encoding, callback) {
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

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
};

const isPathInside = (rootPath, targetPath) => {
  const relativePath = relative(rootPath, targetPath);

  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
};

const readMetadata = async (metadataPath) => {
  let source;

  try {
    source = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return new Map();
    }

    throw error;
  }

  if (!Array.isArray(source)) {
    throw new Error(`Файл метаданных ${metadataPath} должен содержать JSON-массив`);
  }

  const files = new Map();

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

const writeMetadata = async (metadataPath, files) => {
  const temporaryPath = `${metadataPath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    await writeFile(temporaryPath, JSON.stringify([...files.values()], null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

const getFileSize = async (path) => {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw createHttpError(404, 'Файл не найден');
    }

    throw error;
  }
};

/** @param {{ directory: string, metadata: string }} config */
export const createDiskFileStore = async ({ directory: sourceDirectoryPath, metadata: sourceMetadataPath }) => {
  const directoryPath = resolve(sourceDirectoryPath);
  const metadataPath = resolve(sourceMetadataPath);
  const stagingPath = resolve(directoryPath, '.deep-json-server');
  const schedule = createSerialQueue();
  const pendingCleanup = new Set();

  await Promise.all([mkdir(directoryPath, { recursive: true }), mkdir(dirname(metadataPath), { recursive: true }), mkdir(stagingPath, { recursive: true })]);

  const realDirectoryPath = await realpath(directoryPath);
  let files = await readMetadata(metadataPath);

  const assertContained = (path) => {
    if (!isPathInside(realDirectoryPath, path)) {
      throw createHttpError(400, 'Путь файла выходит за пределы директории хранения');
    }
  };

  const resolveFilePath = (path) => {
    const filePath = resolve(directoryPath, path);
    if (filePath === directoryPath || !isPathInside(directoryPath, filePath) || filePath === metadataPath || isPathInside(stagingPath, filePath)) {
      throw createHttpError(400, 'Путь файла выходит за пределы директории хранения');
    }

    return filePath;
  };

  const assertNoSymlinks = async (targetPath) => {
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
        if (error?.code !== 'ENOENT') {
          throw error;
        }
      }
    }
  };

  const prepareTargetPath = async (path) => {
    const filePath = resolveFilePath(path);

    await mkdir(dirname(filePath), { recursive: true });
    await assertNoSymlinks(dirname(filePath));
    assertContained(await realpath(dirname(filePath)));

    if (await pathExists(filePath)) {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
    }

    return filePath;
  };

  const resolveExistingPath = async (path) => {
    const filePath = resolveFilePath(path);

    try {
      await assertNoSymlinks(filePath);
      assertContained(await realpath(filePath));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw createHttpError(404, 'Файл не найден');
      }

      throw error;
    }

    return filePath;
  };

  const cleanupLater = async (path) => {
    try {
      await rm(path, { force: true });
      pendingCleanup.delete(path);
    } catch {
      pendingCleanup.add(path);
    }
  };

  const flushCleanup = async () => Promise.all([...pendingCleanup].map(cleanupLater));

  const findFile = (path) => {
    const file = files.get(path);

    if (file == null) {
      throw createHttpError(404, 'Файл не найден');
    }

    return file;
  };

  const metadata = async (path) => {
    const file = findFile(path);
    const filePath = await resolveExistingPath(path);

    return { ...file, size: await getFileSize(filePath) };
  };

  const get = async (path) => {
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

  const upload = async ({ directory, maxFileSize, mimeType, name, override, stream }) => {
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
        createSizeLimiter(maxFileSize, (value) => (size = value)),
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
          if (installed) {
            await rm(path, { force: true }).catch(() => undefined);
          }

          if (backedUp) {
            await rename(backupPath, path).catch(() => undefined);
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

  const update = (sourcePath, updates) =>
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

      try {
        await writeMetadata(metadataPath, nextFiles);
      } catch (error) {
        await rename(targetFilePath, sourceFilePath).catch(() => undefined);
        throw error;
      }

      files = nextFiles;

      return { ...updatedFile, size: await getFileSize(targetFilePath) };
    });

  const remove = (path) =>
    schedule(async () => {
      await flushCleanup();
      findFile(path);

      const filePath = await resolveExistingPath(path);
      const temporaryPath = `${filePath}.${randomBytes(6).toString('hex')}.delete`;

      await rename(filePath, temporaryPath);

      const nextFiles = new Map(files);

      nextFiles.delete(path);

      try {
        await writeMetadata(metadataPath, nextFiles);
      } catch (error) {
        await rename(temporaryPath, filePath).catch(() => undefined);
        throw error;
      }

      files = nextFiles;
      await cleanupLater(temporaryPath);
    });

  return { get, metadata, remove, update, upload };
};
