import { basename } from 'node:path';
import { createHttpError, isObject } from '../utils.js';

/** @typedef {{ directory: string, mimeType: string, name: string }} StoredFileMetadata */
/** @typedef {StoredFileMetadata & { size: number }} FileRecord */
/** @typedef {FileRecord & { downloadUrl: string, metadataUrl: string, url: string }} FileMetadata */
/** @typedef {{ directory: string, maxFileSize: number, mimeType: string, name: string, override: boolean, stream: import('node:stream').Readable }} FileUpload */
/** @typedef {{ directory?: string, name?: string }} FileUpdate */
/**
 * @typedef {object} FileStore
 * @property {(path: string) => Promise<{ file: FileRecord, stream: import('node:stream').Readable }>} get Returns file metadata and contents.
 * @property {(path: string) => Promise<FileRecord>} metadata Returns file metadata.
 * @property {(path: string) => Promise<void>} remove Deletes a file.
 * @property {(path: string, update: FileUpdate) => Promise<FileRecord>} update Renames or moves a file.
 * @property {(upload: FileUpload) => Promise<{ created: boolean, file: FileRecord }>} upload Stores a file.
 */

export const PATCH_BODY_LIMIT = 64 * 1024;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

export const FILE_METADATA_SCHEMA = {
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

export const FILE_UPDATE_SCHEMA = {
  additionalProperties: false,
  anyOf: [{ required: ['directory'] }, { required: ['name'] }],
  properties: { directory: { type: 'string' }, name: { type: 'string' } },
  type: 'object',
};

export const getFileKey = ({ directory, name }) => [directory, name].filter(Boolean).join('/');

export const validateName = (value, source) => {
  if (typeof value !== 'string' || value === '' || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw createHttpError(400, `${source} должен содержать безопасное имя файла`);
  }

  return value;
};

export const validateDirectory = (value, source) => {
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

export const normalizeMimeType = (value, source = 'Заголовок Content-Type') => {
  const mimeType = typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';

  if (mimeType === '' || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw createHttpError(400, `${source} должен содержать корректный MIME-тип`);
  }

  return mimeType;
};

export const normalizeStoredFileMetadata = (value, source) => {
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
    throw new Error(error.message, { cause: error });
  }
};

export const getPathLocation = (path) => {
  const normalizedPath = validateDirectory(path, 'Путь файла');
  const parts = normalizedPath.split('/');
  const name = validateName(parts.pop(), 'Путь файла');

  return { directory: parts.join('/'), name };
};

const encodeFilePath = (file) => getFileKey(file).split('/').map(encodeURIComponent).join('/');

export const createFileMetadata = (file) => {
  const path = encodeFilePath(file);

  return {
    ...file,
    downloadUrl: `/_files/download/${path}`,
    metadataUrl: `/_files/metadata/${path}`,
    url: `/_files/storage/${path}`,
  };
};

export const getDownloadName = (name) => encodeURIComponent(basename(name)).replaceAll("'", '%27');
