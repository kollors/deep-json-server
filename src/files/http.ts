import { basename } from 'node:path';
import type { OpenapiSchema } from '../types.js';
import { type FileRecord, getFileKey, type StoredFileMetadata } from './contract.js';
export interface FileMetadata extends FileRecord {
  downloadUrl: string;
  metadataUrl: string;
  url: string;
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
