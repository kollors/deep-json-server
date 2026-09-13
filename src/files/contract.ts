import { errorMessage } from '../core/utils.js';
export interface MemoryFile {
  content: Uint8Array;
  directory?: string;
  mimeType: string;
  name: string;
}
export type FilesConfig = { data: MemoryFile[]; directory?: never; metadata?: never } | { data?: never; directory: string; metadata: string };

import type { Readable } from 'node:stream';
import { domainError } from '../core/errors.js';
import { isObject } from '../core/utils.js';

export interface StoredFileMetadata {
  directory: string;
  mimeType: string;
  name: string;
}
export interface FileRecord extends StoredFileMetadata {
  size: number;
}
export interface FileUpload extends StoredFileMetadata {
  maxFileSize: number;
  override: boolean;
  stream: Readable;
}
export interface FileUpdate {
  directory?: string;
  name?: string;
}
export interface FileStore {
  get(path: string): Promise<{ file: FileRecord; stream: Readable }>;
  metadata(path: string): Promise<FileRecord>;
  remove(path: string): Promise<void>;
  update(path: string, update: FileUpdate): Promise<FileRecord>;
  upload(upload: FileUpload): Promise<{ created: boolean; file: FileRecord }>;
}

const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Соединяет непустой каталог и имя через косую черту, не проверяя безопасность пути.
 * @example getFileKey({ directory: 'photos', name: 'a.jpg' }) → 'photos/a.jpg'.
 */
export const getFileKey = ({ directory, name }: Pick<StoredFileMetadata, 'directory' | 'name'>): string => [directory, name].filter(Boolean).join('/');

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Ищет управляющие символы ASCII с кодами 0–31 или 127.
 * @example hasControlCharacter('abc') → false; строка с переводом строки → true.
 */
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);

    return code <= 31 || code === 127;
  });

/** Проверяет безопасное имя файла, включая зарезервированные имена Windows.
 * @example validateName('a.txt', 'name') → 'a.txt'; validateName('../a', 'name') → ошибка.
 */
export const validateName = (value: unknown, source: string): string => {
  if (
    typeof value !== 'string' ||
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.endsWith('.') ||
    value.endsWith(' ') ||
    /[<>:"/\\|?*]/.test(value) ||
    hasControlCharacter(value) ||
    WINDOWS_RESERVED_NAME.test(value)
  ) {
    throw domainError('INVALID_INPUT', `${source} должен содержать безопасное имя файла`);
  }

  return value;
};

/** Проверяет относительный путь с разделителем /; пустой путь обозначает корень.
 * @example validateDirectory('photos/2026', 'path') → 'photos/2026'; '../photos' → ошибка.
 */
export const validateDirectory = (value: unknown, source: string): string => {
  if (typeof value !== 'string') {
    throw domainError('INVALID_INPUT', `${source} должен содержать безопасный относительный путь`);
  }

  if (value === '') {
    return value;
  }

  const parts = value.split('/');

  if (value.startsWith('/') || value.endsWith('/') || value.includes('\\') || value.includes('\0') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw domainError('INVALID_INPUT', `${source} должен содержать безопасный относительный путь`);
  }

  return value;
};

/** Удаляет параметры MIME-типа, приводит его к нижнему регистру и проверяет формат.
 * @example normalizeMimeType('Text/Plain; charset=utf-8') → 'text/plain'.
 */
export const normalizeMimeType = (value: unknown, source = 'Заголовок Content-Type'): string => {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

  if (mimeType === '' || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw domainError('INVALID_INPUT', `${source} должен содержать корректный MIME-тип`);
  }

  return mimeType;
};

/** Проверяет метаданные и возвращает объект из каталога, имени и MIME-типа.
 * @example { name: 'a.txt', mimeType: 'TEXT/PLAIN' } → { directory: '', name: 'a.txt', mimeType: 'text/plain' }.
 */
export const normalizeStoredFileMetadata = (value: unknown, source: string): StoredFileMetadata => {
  if (!isObject(value)) {
    throw new Error(`${source} должна содержать JSON-объект`);
  }

  try {
    return {
      directory: validateDirectory(value.directory ?? '', `${source}.directory`),
      mimeType: normalizeMimeType(value.mimeType, `${source}.mimeType`),
      name: validateName(value.name, `${source}.name`),
    };
  } catch (error) {
    throw new Error(errorMessage(error), { cause: error });
  }
};

/** Разделяет проверенный относительный путь на каталог и имя файла.
 * @example getPathLocation('photos/a.jpg') → { directory: 'photos', name: 'a.jpg' }.
 */
export const getPathLocation = (path: string): Pick<StoredFileMetadata, 'directory' | 'name'> => {
  const normalizedPath = validateDirectory(path, 'Путь файла');
  const parts = normalizedPath.split('/');
  const name = validateName(parts.pop(), 'Путь файла');

  return { directory: parts.join('/'), name };
};
