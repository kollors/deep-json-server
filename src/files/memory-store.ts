import { Readable } from 'node:stream';
import type { MemoryFile } from '../config.js';
import { createHttpError, createSerialQueue } from '../utils.js';
import { type FileRecord, type FileStore, type FileUpdate, type FileUpload, getFileKey, normalizeStoredFileMetadata } from './contract.js';

const readUpload = async (stream: Readable, maxFileSize: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);

    size += buffer.length;

    if (size > maxFileSize) {
      throw createHttpError(413, `Размер файла не должен превышать ${maxFileSize} байт`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

export const createMemoryFileStore = (sourceFiles: MemoryFile[]): FileStore => {
  const storedFiles = new Map<string, { content: Buffer; file: FileRecord }>();

  sourceFiles.forEach((sourceFile, index) => {
    if (!(sourceFile.content instanceof Uint8Array)) {
      throw new Error(`Некорректная запись ${index} в config.files.data`);
    }

    const file = {
      ...normalizeStoredFileMetadata(sourceFile, `Запись ${index} в config.files.data`),
      size: sourceFile.content.length,
    };
    const path = getFileKey(file);

    if (storedFiles.has(path)) {
      throw new Error(`config.files.data содержит повторяющийся путь «${path}»`);
    }

    storedFiles.set(path, { content: Buffer.from(sourceFile.content), file });
  });

  const schedule = createSerialQueue();

  const findStoredFile = (path: string): { content: Buffer; file: FileRecord } => {
    const storedFile = storedFiles.get(path);

    if (storedFile == null) {
      throw createHttpError(404, 'Файл не найден');
    }

    return storedFile;
  };

  const metadata = async (path: string): Promise<FileRecord> => findStoredFile(path).file;
  const get = async (path: string): ReturnType<FileStore['get']> => {
    const storedFile = findStoredFile(path);

    return { file: storedFile.file, stream: Readable.from([storedFile.content]) };
  };

  const upload = async ({ directory, maxFileSize, mimeType, name, override, stream }: FileUpload): ReturnType<FileStore['upload']> => {
    const path = getFileKey({ directory, name });

    if (storedFiles.has(path) && !override) {
      throw createHttpError(409, 'Файл уже существует');
    }

    const content = await readUpload(stream, maxFileSize);

    return schedule(() => {
      const exists = storedFiles.has(path);

      if (exists && !override) {
        throw createHttpError(409, 'Файл уже существует');
      }

      const file = { directory, mimeType, name, size: content.length };

      storedFiles.set(path, { content, file });

      return { created: !exists, file };
    });
  };

  const update = (sourcePath: string, updates: FileUpdate): ReturnType<FileStore['update']> =>
    schedule(() => {
      const storedFile = findStoredFile(sourcePath);
      const file = { ...storedFile.file, ...updates };
      const targetPath = getFileKey(file);

      if (sourcePath !== targetPath && storedFiles.has(targetPath)) {
        throw createHttpError(409, 'Файл с таким путём уже существует');
      }

      storedFiles.delete(sourcePath);
      storedFiles.set(targetPath, { ...storedFile, file });

      return file;
    });

  const remove = (path: string): ReturnType<FileStore['remove']> =>
    schedule(() => {
      if (!storedFiles.delete(path)) {
        throw createHttpError(404, 'Файл не найден');
      }
    });

  return { get, metadata, remove, update, upload };
};
