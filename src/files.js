import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHttpError, createSerialQueue, isObject } from './utils.js';

/** @typedef {{ directory: string, mimeType: string, name: string }} StoredFileMetadata */
/** @typedef {StoredFileMetadata & { size: number }} FileRecord */
/** @typedef {FileRecord & { downloadUrl: string, metadataUrl: string, url: string }} FileMetadata */
/** @typedef {{ directory: string, maxFileSize: number, mimeType: string, name: string, override: boolean, stream: Readable }} FileUpload */
/** @typedef {{ directory?: string, name?: string }} FileUpdate */
/**
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<{ file: FileRecord, stream: Readable }>} get Returns file metadata and contents.
 * @property {(path: string) => Promise<FileRecord>} metadata Returns file metadata.
 * @property {(path: string) => Promise<void>} remove Deletes a file.
 * @property {(path: string, update: FileUpdate) => Promise<FileRecord>} update Renames or moves a file.
 * @property {(upload: FileUpload) => Promise<{ created: boolean, file: FileRecord }>} upload Stores a file.
 */

const PATCH_BODY_LIMIT = 64 * 1024;

const getFileKey = ({ directory, name }) => [directory, name].filter(Boolean).join('/');
const hasValidFileFields = (file) =>
  isObject(file) && typeof file.directory === 'string' && typeof file.mimeType === 'string' && file.mimeType !== '' && typeof file.name === 'string' && file.name !== '';

const validateName = (value, source) => {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw createHttpError(400, `${source} должен содержать безопасное имя файла`);
  }

  return value;
};

const validateDirectory = (value, source) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `${source} должен содержать безопасный относительный путь`);
  }

  if (value === '') {
    return value;
  }

  const parts = value.split('/');

  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\0') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw createHttpError(400, `${source} должен содержать безопасный относительный путь`);
  }

  return value;
};

const validateStoredMetadata = (file) => {
  if (!hasValidFileFields(file)) {
    return false;
  }

  try {
    validateName(file.name, 'Имя файла');
    validateDirectory(file.directory, 'Директория файла');
    return true;
  } catch {
    return false;
  }
};

const validateFileMetadata = (files, metadataPath) => {
  if (!Array.isArray(files)) {
    throw new Error(`Файл метаданных ${metadataPath} должен содержать JSON-массив`);
  }

  const paths = new Set();

  files.forEach((file, index) => {
    if (!validateStoredMetadata(file)) {
      throw new Error(`Некорректная запись ${index} в файле метаданных ${metadataPath}`);
    }

    const path = getFileKey(file);

    if (paths.has(path)) {
      throw new Error(`Файл метаданных ${metadataPath} содержит повторяющийся путь «${path}»`);
    }

    paths.add(path);
  });

  return files;
};

const readMetadata = async (metadataPath) => {
  try {
    return validateFileMetadata(JSON.parse(await readFile(metadataPath, 'utf8')), metadataPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
};

const writeMetadata = async (metadataPath, files) => {
  const temporaryPath = `${metadataPath}.${randomBytes(6).toString('hex')}.tmp`;

  try {
    // Atomic replacement prevents readers from seeing partially written JSON.
    await writeFile(temporaryPath, JSON.stringify(files, null, 2), { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, metadataPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

const decodeHeader = (value, name) => {
  if (typeof value !== 'string') {
    throw createHttpError(400, `Заголовок ${name} обязателен`);
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw createHttpError(400, `Заголовок ${name} содержит некорректное значение`);
  }
};

const getContentName = (value) => validateName(decodeHeader(value, 'Content-Name'), 'Заголовок Content-Name');
const getContentDirectory = (value) => (value == null ? '' : validateDirectory(decodeHeader(value, 'Content-Directory'), 'Заголовок Content-Directory'));

const getContentOverride = (value) => {
  if (value == null || value === 'false') {
    return false;
  }

  if (value === 'true') {
    return true;
  }

  throw createHttpError(400, 'Заголовок Content-Override должен содержать true или false');
};

const getMimeType = (value) => {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

  if (mimeType === '' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    throw createHttpError(400, 'Заголовок Content-Type должен содержать корректный MIME-тип');
  }

  return mimeType;
};

const getPathLocation = (path) => {
  const normalizedPath = validateDirectory(path, 'Путь файла');
  const parts = normalizedPath.split('/');
  const name = validateName(parts.pop(), 'Путь файла');

  return { directory: parts.join('/'), name };
};

const encodeFilePath = (file) => getFileKey(file).split('/').map(encodeURIComponent).join('/');

const createFileMetadata = (file) => {
  const path = encodeFilePath(file);

  return {
    ...file,
    downloadUrl: `/_files/download/${path}`,
    metadataUrl: `/_files/metadata/${path}`,
    url: `/_files/storage/${path}`,
  };
};

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

const createDiskFileStore = async ({ directory: sourceDirectoryPath, metadata: sourceMetadataPath }) => {
  if (typeof sourceDirectoryPath !== 'string' || sourceDirectoryPath.trim() === '') {
    throw new Error('Путь к директории файлов не должен быть пустым');
  }

  if (typeof sourceMetadataPath !== 'string' || sourceMetadataPath.trim() === '') {
    throw new Error('Путь к файлу метаданных не должен быть пустым');
  }

  const directoryPath = resolve(sourceDirectoryPath);
  const metadataPath = resolve(sourceMetadataPath);
  const schedule = createSerialQueue();

  await Promise.all([mkdir(directoryPath, { recursive: true }), mkdir(dirname(metadataPath), { recursive: true })]);
  await readMetadata(metadataPath);

  const resolveFilePath = (path) => {
    const filePath = resolve(directoryPath, path);
    const relativePath = relative(directoryPath, filePath);

    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath) || filePath === metadataPath) {
      throw createHttpError(400, 'Путь файла выходит за пределы директории хранения');
    }

    return filePath;
  };

  const getMetadata = async (path) => {
    const files = await readMetadata(metadataPath);
    const file = files.find((item) => getFileKey(item) === path);

    if (file == null) {
      throw createHttpError(404, 'Файл не найден');
    }

    const filePath = resolveFilePath(path);

    return { ...file, size: await getFileSize(filePath) };
  };

  const metadata = (path) => schedule(async () => getMetadata(path));
  const get = (path) =>
    schedule(async () => {
      const file = await getMetadata(path);

      return { file, stream: createReadStream(resolveFilePath(path)) };
    });

  const upload = ({ directory, maxFileSize, mimeType, name, override, stream }) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const storedFile = { directory, mimeType, name };
      const file = { ...storedFile, size: 0 };
      const key = getFileKey(file);
      const index = files.findIndex((item) => getFileKey(item) === key);
      const path = resolveFilePath(key);
      const exists = index !== -1 || (await pathExists(path));

      if (exists && !override) {
        throw createHttpError(409, 'Файл уже существует');
      }

      await mkdir(dirname(path), { recursive: true });

      const temporaryPath = `${path}.${randomBytes(6).toString('hex')}.upload`;
      const backupPath = `${path}.${randomBytes(6).toString('hex')}.backup`;
      let backedUp = false;
      let installed = false;

      try {
        await pipeline(
          stream,
          createSizeLimiter(maxFileSize, (size) => (file.size = size)),
          createWriteStream(temporaryPath, { flags: 'wx' }),
        );

        if (await pathExists(path)) {
          await rename(path, backupPath);
          backedUp = true;
        }

        await rename(temporaryPath, path);
        installed = true;

        if (index === -1) {
          files.push(storedFile);
        } else {
          files.splice(index, 1, storedFile);
        }

        await writeMetadata(metadataPath, files);
        await rm(backupPath, { force: true });

        return { created: !exists, file };
      } catch (error) {
        await rm(temporaryPath, { force: true });

        if (installed) {
          await rm(path, { force: true });
        }

        if (backedUp) {
          await rename(backupPath, path);
        }

        throw error;
      }
    });

  const update = (sourcePath, updates) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const index = files.findIndex((file) => getFileKey(file) === sourcePath);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      const file = files[index];
      const updatedFile = { ...file, ...updates };
      const targetPath = getFileKey(updatedFile);
      const sourceFilePath = resolveFilePath(sourcePath);

      if (!(await pathExists(sourceFilePath))) {
        throw createHttpError(404, 'Файл не найден');
      }

      if (sourcePath === targetPath) {
        return { ...file, size: await getFileSize(sourceFilePath) };
      }

      if (files.some((item, itemIndex) => itemIndex !== index && getFileKey(item) === targetPath) || (await pathExists(resolveFilePath(targetPath)))) {
        throw createHttpError(409, 'Файл с таким путём уже существует');
      }

      const targetFilePath = resolveFilePath(targetPath);

      await mkdir(dirname(targetFilePath), { recursive: true });
      await rename(sourceFilePath, targetFilePath);
      files.splice(index, 1, updatedFile);

      try {
        await writeMetadata(metadataPath, files);
      } catch (error) {
        await rename(targetFilePath, sourceFilePath);
        throw error;
      }

      return { ...updatedFile, size: await getFileSize(targetFilePath) };
    });

  const remove = (path) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const index = files.findIndex((file) => getFileKey(file) === path);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      files.splice(index, 1);

      const filePath = resolveFilePath(path);
      const temporaryPath = `${filePath}.${randomBytes(6).toString('hex')}.delete`;

      try {
        await rename(filePath, temporaryPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw createHttpError(404, 'Файл не найден');
        }

        throw error;
      }

      try {
        await writeMetadata(metadataPath, files);
      } catch (error) {
        await rename(temporaryPath, filePath);
        throw error;
      }

      await rm(temporaryPath, { force: true }).catch(() => undefined);
    });

  return { get, metadata, remove, update, upload };
};

const createMemoryFileStore = (sourceFiles) => {
  const paths = new Set();
  const storedFiles = sourceFiles.map((sourceFile, index) => {
    const directory = sourceFile.directory ?? '';
    const file = { directory, mimeType: sourceFile.mimeType, name: sourceFile.name, size: sourceFile.content?.length };

    if (!validateStoredMetadata(file) || !Number.isInteger(file.size) || file.size < 0 || !(sourceFile.content instanceof Uint8Array)) {
      throw new Error(`Некорректная запись ${index} в config.files.data`);
    }

    const path = getFileKey(file);

    if (paths.has(path)) {
      throw new Error(`config.files.data содержит повторяющийся путь «${path}»`);
    }

    paths.add(path);

    return { content: Buffer.from(sourceFile.content), file };
  });
  const schedule = createSerialQueue();

  const findStoredFile = (path) => {
    const storedFile = storedFiles.find(({ file }) => getFileKey(file) === path);

    if (storedFile == null) {
      throw createHttpError(404, 'Файл не найден');
    }

    return storedFile;
  };

  const metadata = (path) => schedule(async () => findStoredFile(path).file);

  const get = (path) =>
    schedule(async () => {
      const storedFile = findStoredFile(path);

      return { file: storedFile.file, stream: Readable.from([storedFile.content]) };
    });

  const upload = ({ directory, maxFileSize, mimeType, name, override, stream }) =>
    schedule(async () => {
      const chunks = [];
      let size = 0;

      for await (const chunk of stream) {
        const buffer = Buffer.from(chunk);

        size += buffer.length;

        if (size > maxFileSize) {
          throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
        }

        chunks.push(buffer);
      }

      const file = { directory, mimeType, name, size };
      const path = getFileKey(file);
      const index = storedFiles.findIndex((item) => getFileKey(item.file) === path);

      if (index !== -1 && !override) {
        throw createHttpError(409, 'Файл уже существует');
      }

      const storedFile = { content: Buffer.concat(chunks), file };

      if (index === -1) {
        storedFiles.push(storedFile);
      } else {
        storedFiles.splice(index, 1, storedFile);
      }

      return { created: index === -1, file };
    });

  const update = (sourcePath, updates) =>
    schedule(async () => {
      const index = storedFiles.findIndex(({ file }) => getFileKey(file) === sourcePath);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      const storedFile = storedFiles[index];
      const file = { ...storedFile.file, ...updates };
      const targetPath = getFileKey(file);

      if (sourcePath !== targetPath && storedFiles.some((item, itemIndex) => itemIndex !== index && getFileKey(item.file) === targetPath)) {
        throw createHttpError(409, 'Файл с таким путём уже существует');
      }

      storedFiles.splice(index, 1, { ...storedFile, file });

      return file;
    });

  const remove = (path) =>
    schedule(async () => {
      const index = storedFiles.findIndex(({ file }) => getFileKey(file) === path);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      storedFiles.splice(index, 1);
    });

  return { get, metadata, remove, update, upload };
};

const readJsonObject = async (stream) => {
  const chunks = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);

    size += buffer.length;

    if (size > PATCH_BODY_LIMIT) {
      throw createHttpError(413, `Размер тела запроса не должен превышать ${PATCH_BODY_LIMIT} байт`);
    }

    chunks.push(buffer);
  }

  let body;

  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw createHttpError(400, 'Тело запроса должно содержать корректный JSON');
  }

  if (!isObject(body)) {
    throw createHttpError(400, 'Тело запроса должно быть JSON-объектом');
  }

  const unknownKey = Object.keys(body).find((key) => key !== 'directory' && key !== 'name');

  if (unknownKey != null) {
    throw createHttpError(400, `Неизвестный ключ body.${unknownKey}`);
  }

  if (body.directory == null && body.name == null) {
    throw createHttpError(400, 'Укажите новое имя или директорию файла');
  }

  return {
    ...(body.directory != null && { directory: validateDirectory(body.directory, 'Ключ body.directory') }),
    ...(body.name != null && { name: validateName(body.name, 'Ключ body.name') }),
  };
};

/**
 * Creates a disk- or memory-backed file store with serialized operations.
 * @param {import('./config.js').FilesConfig} config File storage configuration.
 * @returns {Promise<FileStore>} File store.
 */
export const createFileStore = async (config) => ('data' in config ? createMemoryFileStore(config.data) : createDiskFileStore(config));

const getDownloadName = (name) => encodeURIComponent(basename(name)).replaceAll("'", '%27');

const sendFile = async (store, path, reply, disposition) => {
  const { file, stream } = await store.get(path);

  reply.header('Content-Disposition', `${disposition}; filename*=UTF-8''${getDownloadName(file.name)}`);
  reply.type(file.mimeType);

  return reply.send(stream);
};

export const registerFileRoutes = (fastify, { maxFileSize, store }) => {
  fastify.register((fileServer, _options, done) => {
    fileServer.removeAllContentTypeParsers();
    fileServer.addContentTypeParser('*', (_request, payload, parserDone) => parserDone(null, payload));

    fileServer.post('/_files/storage', async (request, reply) => {
      const contentLength = Number(request.headers['content-length']);

      if (Number.isFinite(contentLength) && contentLength > maxFileSize) {
        throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
      }

      const result = await store.upload({
        directory: getContentDirectory(request.headers['content-directory']),
        maxFileSize,
        mimeType: getMimeType(request.headers['content-type']),
        name: getContentName(request.headers['content-name']),
        override: getContentOverride(request.headers['content-override']),
        stream: request.body,
      });

      return reply.code(result.created ? 201 : 200).send(createFileMetadata(result.file));
    });

    fileServer.get('/_files/storage/*', async (request, reply) => sendFile(store, getFileKey(getPathLocation(request.params['*'])), reply, 'inline'));
    fileServer.get('/_files/download/*', async (request, reply) => sendFile(store, getFileKey(getPathLocation(request.params['*'])), reply, 'attachment'));

    fileServer.get('/_files/metadata/*', async (request) => {
      const file = await store.metadata(getFileKey(getPathLocation(request.params['*'])));

      return createFileMetadata(file);
    });

    fileServer.patch('/_files/storage/*', async (request) => {
      if (getMimeType(request.headers['content-type']) !== 'application/json') {
        throw createHttpError(415, 'Для изменения файла используйте Content-Type: application/json');
      }

      const sourcePath = getFileKey(getPathLocation(request.params['*']));
      const update = await readJsonObject(request.body);

      return createFileMetadata(await store.update(sourcePath, update));
    });

    fileServer.delete('/_files/storage/*', async (request, reply) => {
      await store.remove(getFileKey(getPathLocation(request.params['*'])));

      return reply.code(204).send();
    });

    done();
  });
};
