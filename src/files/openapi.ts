import { FILE_ROUTES } from './http.js';

type OpenapiObject = Record<string, unknown>;

import { json as createJsonContent, response as createResponse, ref as createSchemaReference } from '../openapi/helpers.js';

const createErrorResponse = (description: string): OpenapiObject => createResponse(description, createSchemaReference('Error'));
const createParameterReference = (name: string): OpenapiObject => ({ $ref: `#/components/parameters/${name}` });
const createRequestBody = (name: string): OpenapiObject => ({ required: true, ...createJsonContent(createSchemaReference(name)) });

export const createFilePaths = (): Record<string, OpenapiObject> => ({
  [`${FILE_ROUTES.download}/{path}`]: {
    get: {
      operationId: 'downloadFile',
      parameters: [createParameterReference('FilePath')],
      responses: {
        200: { content: { '*/*': { schema: { format: 'binary', type: 'string' } } }, description: 'File download' },
        400: createErrorResponse('Invalid path'),
        404: createErrorResponse('Not found'),
      },
      tags: ['files'],
    },
  },
  [`${FILE_ROUTES.metadata}/{path}`]: {
    get: {
      operationId: 'getFileMetadata',
      parameters: [createParameterReference('FilePath')],
      responses: {
        200: createResponse('File metadata', createSchemaReference('FileMetadata')),
        400: createErrorResponse('Invalid path'),
        404: createErrorResponse('Not found'),
      },
      tags: ['files'],
    },
  },
  [FILE_ROUTES.storage]: {
    post: {
      operationId: 'uploadFile',
      parameters: ['ContentName', 'ContentDirectory', 'ContentOverride'].map(createParameterReference),
      requestBody: { content: { '*/*': { schema: { format: 'binary', type: 'string' } } }, required: true },
      responses: {
        200: createResponse('Overwritten', createSchemaReference('FileMetadata')),
        201: createResponse('Created', createSchemaReference('FileMetadata')),
        400: createErrorResponse('Invalid request'),
        409: createErrorResponse('Already exists'),
        413: createErrorResponse('File is too large'),
        415: createErrorResponse('Unsupported media type'),
      },
      tags: ['files'],
    },
  },
  [`${FILE_ROUTES.storage}/{path}`]: {
    delete: {
      operationId: 'deleteFile',
      parameters: [createParameterReference('FilePath')],
      responses: {
        204: { description: 'Deleted' },
        400: createErrorResponse('Invalid path'),
        404: createErrorResponse('Not found'),
      },
      tags: ['files'],
    },
    get: {
      operationId: 'getFileContent',
      parameters: [createParameterReference('FilePath')],
      responses: {
        200: { content: { '*/*': { schema: { format: 'binary', type: 'string' } } }, description: 'File contents' },
        400: createErrorResponse('Invalid path'),
        404: createErrorResponse('Not found'),
      },
      tags: ['files'],
    },
    patch: {
      operationId: 'updateFile',
      parameters: [createParameterReference('FilePath')],
      requestBody: createRequestBody('FileUpdate'),
      responses: {
        200: createResponse('Updated', createSchemaReference('FileMetadata')),
        400: createErrorResponse('Invalid request'),
        404: createErrorResponse('Not found'),
        409: createErrorResponse('Already exists'),
        413: createErrorResponse('Request is too large'),
        415: createErrorResponse('Unsupported media type'),
      },
      tags: ['files'],
    },
  },
});
