import { basename } from 'node:path';
import type { Readable } from 'node:stream';
import type { OpenapiSchema } from '../types.js';
import { createHttpError, isObject } from '../utils.js';

export interface StoredFileMetadata {
  directory: string;
  mimeType: string;
  name: string;
}
export interface FileRecord extends StoredFileMetadata {
  size: number;
}
export interface FileMetadata extends FileRecord {
  downloadUrl: string;
  metadataUrl: string;
  url: string;
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

export const FILE_HEADERS = {
  directory: { key: 'content-directory', name: 'Content-Directory' },
  name: { key: 'content-name', name: 'Content-Name' },
  override: { key: 'content-override', name: 'Content-Override' },
} as const;

export const FILE_ROUTES = {
  download: '/_files/download',
  metadata: '/_files/metadata',
  storage: '/_files/storage',
} as const;

export const PATCH_BODY_LIMIT = 64 * 1024;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export const FILE_METADATA_SCHEMA: OpenapiSchema = {
  properties: {
    directory: { type: 'string' },
    downloadUrl: { format: 'uri-reference', type: 'string' },
    metadataUrl: { format: 'uri-reference', type: 'string' },
    mimeType: { type: 'string' },
    name: { type: 'string' },
    size: { minimum: 0, type: 'integer' },
    url: { format: 'uri-reference', type: 'string' },
  },
  required: ['directory', 'downloadUrl', 'metadataUrl', 'mimeType', 'name', 'size', 'url'],
  type: 'object',
};

export const FILE_UPDATE_SCHEMA: OpenapiSchema = {
  additionalProperties: false,
  anyOf: [{ required: ['directory'] }, { required: ['name'] }],
  properties: { directory: { type: 'string' }, name: { type: 'string' } },
  type: 'object',
};

export const getFileKey = ({ directory, name }: Pick<StoredFileMetadata, 'directory' | 'name'>): string => [directory, name].filter(Boolean).join('/');

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);

    return code <= 31 || code === 127;
  });

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
    throw createHttpError(400, `${source} должен содержать безопасное имя файла`);
  }

  return value;
};

export const validateDirectory = (value: unknown, source: string): string => {
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

export const normalizeMimeType = (value: unknown, source = 'Заголовок Content-Type'): string => {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

  if (mimeType === '' || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw createHttpError(400, `${source} должен содержать корректный MIME-тип`);
  }

  return mimeType;
};

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
    throw new Error(error instanceof Error ? error.message : String(error), { cause: error });
  }
};

export const getPathLocation = (path: string): Pick<StoredFileMetadata, 'directory' | 'name'> => {
  const normalizedPath = validateDirectory(path, 'Путь файла');
  const parts = normalizedPath.split('/');
  const name = validateName(parts.pop(), 'Путь файла');

  return { directory: parts.join('/'), name };
};

const encodeFilePath = (file: StoredFileMetadata): string => getFileKey(file).split('/').map(encodeURIComponent).join('/');

export const createFileMetadata = (file: FileRecord): FileMetadata => {
  const path = encodeFilePath(file);

  return {
    ...file,
    downloadUrl: `${FILE_ROUTES.download}/${path}`,
    metadataUrl: `${FILE_ROUTES.metadata}/${path}`,
    url: `${FILE_ROUTES.storage}/${path}`,
  };
};

export const getDownloadName = (name: string): string => encodeURIComponent(basename(name)).replaceAll("'", '%27');
