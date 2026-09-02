import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHttpError, createSerialQueue, createUniqueId, isObject } from './utils.js';

/** @typedef {{ id: string, mimeType: string, name: string, size: number, url: string }} FileMetadata */
/** @typedef {{ maxFileSize: number, mimeType: string, name: string, stream: Readable }} FileUpload */
/**
 * @typedef {object} FileStore
 * @property {(id: string) => Promise<{ file: FileMetadata, stream: Readable }>} get Returns file metadata and contents.
 * @property {(id: string) => Promise<FileMetadata>} remove Deletes a file.
 * @property {(upload: FileUpload) => Promise<FileMetadata>} upload Stores a file.
 */

const hasValidFileFields = (file) =>
  isObject(file) && typeof file.id === 'string' && file.id !== '' && typeof file.mimeType === 'string' && file.mimeType !== '' && typeof file.name === 'string' && file.name !== '';

const validateFileMetadata = (files, metadataPath) => {
  if (!Array.isArray(files)) {
    throw new Error(`Файл метаданных ${metadataPath} должен содержать JSON-массив`);
  }

  const ids = new Set();

  files.forEach((file, index) => {
    if (!hasValidFileFields(file) || !Number.isInteger(file.size) || file.size < 0 || file.url !== `/_files/${file.id}`) {
      throw new Error(`Некорректная запись ${index} в файле метаданных ${metadataPath}`);
    }

    if (ids.has(file.id)) {
      throw new Error(`Файл метаданных ${metadataPath} содержит повторяющийся id «${file.id}»`);
    }

    ids.add(file.id);
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

const getContentName = (value) => {
  if (typeof value !== 'string' || value === '') {
    throw createHttpError(400, 'Заголовок Content-Name обязателен');
  }

  let name;

  try {
    name = decodeURIComponent(value).replaceAll('\\', '/');
  } catch {
    throw createHttpError(400, 'Заголовок Content-Name содержит некорректное значение');
  }

  const parts = name.split('/');

  if (name.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\0'))) {
    throw createHttpError(400, 'Заголовок Content-Name должен содержать безопасный относительный путь');
  }

  return name;
};

const getMimeType = (value) => {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

  if (mimeType === '' || !/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(mimeType)) {
    throw createHttpError(400, 'Заголовок Content-Type должен содержать корректный MIME-тип');
  }

  return mimeType;
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

  const get = (id) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const file = files.find((item) => item.id === id);

      if (file == null) {
        throw createHttpError(404, 'Файл не найден');
      }

      const path = join(directoryPath, file.id);

      try {
        await access(path);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw createHttpError(404, 'Файл не найден');
        }

        throw error;
      }

      return { file, stream: createReadStream(path) };
    });

  const upload = ({ maxFileSize, mimeType, name, stream }) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const id = createUniqueId((value) => files.some((file) => file.id === value));
      const path = join(directoryPath, id);
      const temporaryPath = `${path}.upload`;
      let size = 0;

      try {
        await pipeline(
          stream,
          createSizeLimiter(maxFileSize, (value) => (size = value)),
          createWriteStream(temporaryPath, { flags: 'wx' }),
        );
        await rename(temporaryPath, path);

        const file = { id, mimeType, name, size, url: `/_files/${id}` };

        files.push(file);
        await writeMetadata(metadataPath, files);

        return file;
      } catch (error) {
        await Promise.all([rm(temporaryPath, { force: true }), rm(path, { force: true })]);
        throw error;
      }
    });

  const remove = (id) =>
    schedule(async () => {
      const files = await readMetadata(metadataPath);
      const index = files.findIndex((file) => file.id === id);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      const [file] = files.splice(index, 1);
      const path = join(directoryPath, file.id);
      const temporaryPath = `${path}.${randomBytes(6).toString('hex')}.delete`;

      try {
        await rename(path, temporaryPath);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw createHttpError(404, 'Файл не найден');
        }

        throw error;
      }

      try {
        await writeMetadata(metadataPath, files);
      } catch (error) {
        // Restore the file when the metadata update cannot be committed.
        await rename(temporaryPath, path);
        throw error;
      }

      await rm(temporaryPath, { force: true }).catch(() => undefined);

      return file;
    });

  return { get, remove, upload };
};

const createMemoryFileStore = (sourceFiles) => {
  const ids = new Set();
  const storedFiles = sourceFiles.map((sourceFile, index) => {
    if (!hasValidFileFields(sourceFile) || !(sourceFile.content instanceof Uint8Array)) {
      throw new Error(`Некорректная запись ${index} в config.files.data`);
    }

    if (ids.has(sourceFile.id)) {
      throw new Error(`config.files.data содержит повторяющийся id «${sourceFile.id}»`);
    }

    ids.add(sourceFile.id);

    const content = Buffer.from(sourceFile.content);

    return {
      content,
      file: { id: sourceFile.id, mimeType: sourceFile.mimeType, name: sourceFile.name, size: content.length, url: `/_files/${sourceFile.id}` },
    };
  });
  const schedule = createSerialQueue();

  const get = (id) =>
    schedule(async () => {
      const storedFile = storedFiles.find(({ file }) => file.id === id);

      if (storedFile == null) {
        throw createHttpError(404, 'Файл не найден');
      }

      return { file: storedFile.file, stream: Readable.from([storedFile.content]) };
    });

  const upload = ({ maxFileSize, mimeType, name, stream }) =>
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

      const id = createUniqueId((value) => storedFiles.some(({ file }) => file.id === value));
      const file = { id, mimeType, name, size, url: `/_files/${id}` };

      storedFiles.push({ content: Buffer.concat(chunks), file });

      return file;
    });

  const remove = (id) =>
    schedule(async () => {
      const index = storedFiles.findIndex(({ file }) => file.id === id);

      if (index === -1) {
        throw createHttpError(404, 'Файл не найден');
      }

      return storedFiles.splice(index, 1)[0].file;
    });

  return { get, remove, upload };
};

/**
 * Creates a disk- or memory-backed file store with serialized operations.
 * @param {import('./config.js').FilesConfig} config File storage configuration.
 * @returns {Promise<FileStore>} File store.
 */
export const createFileStore = async (config) => ('data' in config ? createMemoryFileStore(config.data) : createDiskFileStore(config));

const getDownloadName = (name) => encodeURIComponent(basename(name)).replaceAll("'", '%27');

export const registerFileRoutes = (fastify, { maxFileSize, store }) => {
  fastify.register((fileServer, _options, done) => {
    fileServer.removeAllContentTypeParsers();
    fileServer.addContentTypeParser('*', (_request, payload, parserDone) => parserDone(null, payload));

    fileServer.post('/_files', async (request, reply) => {
      const contentLength = Number(request.headers['content-length']);

      if (Number.isFinite(contentLength) && contentLength > maxFileSize) {
        throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
      }

      const file = await store.upload({
        maxFileSize,
        mimeType: getMimeType(request.headers['content-type']),
        name: getContentName(request.headers['content-name']),
        stream: request.body,
      });

      return reply.code(201).send(file);
    });

    fileServer.get('/_files/:id', async (request, reply) => {
      const { file, stream } = await store.get(request.params.id);

      reply.header('Content-Disposition', `inline; filename*=UTF-8''${getDownloadName(file.name)}`);
      reply.type(file.mimeType);

      return reply.send(stream);
    });

    fileServer.delete('/_files/:id', async (request) => store.remove(request.params.id));
    done();
  });
};
