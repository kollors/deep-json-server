import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { domainError } from '../core/errors.js';
import { createSerialQueue } from '../core/utils.js';
import type { MemoryFile } from './contract.js';
import { type FileRecord, type FileStore, type FileUpdate, type FileUpload, getFileKey, normalizeStoredFileMetadata } from './contract.js';
import { createSizeLimiter } from './streams.js';

/** Собирает поток в буфер, прекращая чтение при превышении лимита байтов.
 * @example Поток из Buffer.from('abc') и лимит 3 → Buffer('abc'); лимит 2 → ошибка.
 */
const readUpload = async (stream: Readable, maxFileSize: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  await pipeline(
    stream,
    createSizeLimiter(maxFileSize, (value) => {
      size = value;
    }),
    async (source) => {
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
    },
  );
  return Buffer.concat(chunks, size);
};

/** Копирует начальные файлы в память и создаёт операции чтения и изменения.
 * @example createMemoryFileStore([]) → FileStore; последующая загрузка сохраняется только в памяти.
 */
export const createMemoryFileStore = (sourceFiles: MemoryFile[]): FileStore => {
  const storedFiles = new Map<string, { content: Buffer; file: FileRecord }>();

  sourceFiles.forEach((sourceFile, index) => {
    if (!(sourceFile.content instanceof Uint8Array)) {
      throw new Error(`Некорректная запись ${index} в config.files.source`);
    }

    const file = {
      ...normalizeStoredFileMetadata(sourceFile, `Запись ${index} в config.files.source`),
      size: sourceFile.content.length,
    };
    const path = getFileKey(file);

    if (storedFiles.has(path)) {
      throw new Error(`config.files.source содержит повторяющийся путь «${path}»`);
    }

    storedFiles.set(path, { content: Buffer.from(sourceFile.content), file });
  });

  const schedule = createSerialQueue();

  const findStoredFile = (path: string): { content: Buffer; file: FileRecord } => {
    const storedFile = storedFiles.get(path);

    if (storedFile == null) {
      throw domainError('NOT_FOUND', 'Файл не найден');
    }

    return storedFile;
  };

  const metadata = async (path: string): Promise<FileRecord> => ({ ...findStoredFile(path).file });
  const get = async (path: string): ReturnType<FileStore['get']> => {
    const storedFile = findStoredFile(path);

    return { file: { ...storedFile.file }, stream: Readable.from([Buffer.from(storedFile.content)]) };
  };

  const upload = async ({ directory, maxFileSize, mimeType, name, override, stream }: FileUpload): ReturnType<FileStore['upload']> => {
    const path = getFileKey({ directory, name });

    if (storedFiles.has(path) && !override) {
      throw domainError('CONFLICT', 'Файл уже существует');
    }

    const content = await readUpload(stream, maxFileSize);

    return schedule(() => {
      const exists = storedFiles.has(path);

      if (exists && !override) {
        throw domainError('CONFLICT', 'Файл уже существует');
      }

      const file = { directory, mimeType, name, size: content.length };

      storedFiles.set(path, { content, file });

      return { created: !exists, file: { ...file } };
    });
  };

  const update = (sourcePath: string, updates: FileUpdate): ReturnType<FileStore['update']> =>
    schedule(() => {
      const storedFile = findStoredFile(sourcePath);
      const file = { ...storedFile.file, ...updates };
      const targetPath = getFileKey(file);

      if (sourcePath !== targetPath && storedFiles.has(targetPath)) {
        throw domainError('CONFLICT', 'Файл с таким путём уже существует');
      }

      storedFiles.delete(sourcePath);
      storedFiles.set(targetPath, { ...storedFile, file });

      return { ...file };
    });

  const remove = (path: string): ReturnType<FileStore['remove']> =>
    schedule(() => {
      if (!storedFiles.delete(path)) {
        throw domainError('NOT_FOUND', 'Файл не найден');
      }
    });

  return { get, metadata, remove, update, upload };
};
