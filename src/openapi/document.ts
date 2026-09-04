import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../constants.js';
import { validateDatabase } from '../database.js';
import { FILE_HEADERS, FILE_METADATA_SCHEMA, FILE_ROUTES, FILE_UPDATE_SCHEMA } from '../files/contract.js';
import { getRelationMetadata, type RelationMetadata } from '../relation-metadata.js';
import type { DatabaseData, JsonObject, OpenapiDocument, OpenapiSchema } from '../types.js';
import { getResourceNames, isObject, singularize, toPascalCase } from '../utils.js';
import { applyConfiguredFields, normalizeSchemaConfig } from './config.js';
import { ensureGeneratedIdSchema, inferObjectSchema, mergeSchemaOverrides, omitId } from './inference.js';

type OpenapiObject = Record<string, unknown>;
type SchemaMap = Record<string, OpenapiSchema>;

export interface BuildOpenapiOptions {
  database: DatabaseData;
  files?: boolean;
  maxPageSize?: number;
  schema?: JsonObject;
}

const createSchemaReference = (name: string): OpenapiSchema => ({ $ref: `#/components/schemas/${name}` });

const addForwardRelations = (schema: OpenapiSchema, resources: string[], componentNames: Record<string, string>, sourceResource: string): OpenapiSchema => {
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map((nestedSchema) => addForwardRelations(nestedSchema, resources, componentNames, sourceResource)) };
  }

  if (schema.type === 'array') {
    return { ...schema, items: addForwardRelations(schema.items ?? {}, resources, componentNames, sourceResource) };
  }

  if (schema.type !== 'object' || !isObject(schema.properties)) {
    return schema;
  }

  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, addForwardRelations(value, resources, componentNames, sourceResource)]));

  Object.keys(schema.properties).forEach((key) => {
    const relation = getRelationMetadata(key, resources, sourceResource);

    if (relation != null) {
      const relationSchema = createSchemaReference(componentNames[relation.targetResource]);

      properties[relation.relationName] = relation.isMany ? { items: relationSchema, type: 'array' } : relationSchema;
    }
  });

  return { ...schema, properties };
};

const collectRelations = (schema: OpenapiSchema, resources: string[], sourceResource: string, relations: RelationMetadata[] = []): RelationMetadata[] => {
  if (Array.isArray(schema.oneOf)) {
    schema.oneOf.forEach((nestedSchema) => {
      collectRelations(nestedSchema, resources, sourceResource, relations);
    });
    return relations;
  }

  if (schema.type === 'array') {
    collectRelations(schema.items ?? {}, resources, sourceResource, relations);
    return relations;
  }

  if (schema.type !== 'object' || !isObject(schema.properties)) {
    return relations;
  }

  Object.entries(schema.properties).forEach(([key, value]) => {
    const relation = getRelationMetadata(key, resources, sourceResource);

    if (relation != null) {
      relations.push(relation);
    }

    collectRelations(value, resources, sourceResource, relations);
  });

  return relations;
};

const addReverseRelations = (schemas: SchemaMap, rawSchemas: SchemaMap, resources: string[], componentNames: Record<string, string>): void => {
  resources.forEach((sourceResource) => {
    collectRelations(rawSchemas[sourceResource], resources, sourceResource).forEach(({ reverseRelationName, targetResource }) => {
      const targetComponentName = componentNames[targetResource];
      const targetSchema = schemas[targetComponentName];

      if (targetSchema.type === 'object' && isObject(targetSchema.properties) && !Object.hasOwn(targetSchema.properties, reverseRelationName)) {
        schemas[targetComponentName] = {
          ...targetSchema,
          properties: {
            ...targetSchema.properties,
            [reverseRelationName]: { items: createSchemaReference(componentNames[sourceResource]), type: 'array' },
          },
        };
      }
    });
  });
};

const createParameters = (maxPageSize: number): OpenapiObject => ({
  ContentDirectory: { description: 'URI-encoded relative storage directory', in: 'header', name: FILE_HEADERS.directory.name, schema: { type: 'string' } },
  ContentName: { description: 'URI-encoded file name', in: 'header', name: FILE_HEADERS.name.name, required: true, schema: { type: 'string' } },
  ContentOverride: {
    description: 'Overwrite an existing file at the same path',
    in: 'header',
    name: FILE_HEADERS.override.name,
    schema: { default: 'false', enum: ['false', 'true'], type: 'string' },
  },
  Embed: { description: 'Relationship paths to embed', explode: true, in: 'query', name: '_embed', schema: { items: { type: 'string' }, type: 'array' }, style: 'form' },
  FilePath: { description: 'Percent-encoded file path relative to the storage directory', in: 'path', name: 'path', required: true, schema: { type: 'string' } },
  Id: { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
  Page: { in: 'query', name: '_page', required: false, schema: { default: 1, minimum: 1, type: 'integer' } },
  PerPage: { in: 'query', name: '_perPage', required: false, schema: { default: DEFAULT_PAGE_SIZE, maximum: maxPageSize, minimum: 1, type: 'integer' } },
  Sort: { description: 'Comma-separated fields; prefix with - for descending order', in: 'query', name: '_sort', schema: { type: 'string' } },
  Where: { description: 'JSON-encoded filter for nested data', in: 'query', name: '_where', schema: { type: 'string' } },
});

const createJsonContent = (schema: OpenapiSchema): OpenapiObject => ({ content: { 'application/json': { schema } } });
const createResponse = (description: string, schema?: OpenapiSchema): OpenapiObject => ({ description, ...(schema != null && createJsonContent(schema)) });
const createErrorResponse = (description: string): OpenapiObject => createResponse(description, createSchemaReference('Error'));
const createParameterReference = (name: string): OpenapiObject => ({ $ref: `#/components/parameters/${name}` });
const createRequestBody = (name: string): OpenapiObject => ({ required: true, ...createJsonContent(createSchemaReference(name)) });

const createFilePaths = (): Record<string, OpenapiObject> => ({
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

const createResourceOperationIds = (resource: string): Record<'create' | 'get' | 'list' | 'remove' | 'replace' | 'update', string> => {
  const resourceName = toPascalCase(resource);

  return {
    create: `post${resourceName}`,
    get: `get${resourceName}ById`,
    list: `get${resourceName}`,
    remove: `delete${resourceName}ById`,
    replace: `put${resourceName}ById`,
    update: `patch${resourceName}ById`,
  };
};

const createResourcePaths = (resource: string, componentName: string): Record<string, OpenapiObject> => {
  const operationIds = createResourceOperationIds(resource);

  return {
    [`/${resource}`]: {
      get: {
        operationId: operationIds.list,
        parameters: ['Page', 'PerPage', 'Sort', 'Where', 'Embed'].map(createParameterReference),
        responses: { 200: createResponse('Successful response', createSchemaReference(`${componentName}Page`)), 400: createErrorResponse('Invalid query') },
        tags: [resource],
      },
      post: {
        operationId: operationIds.create,
        requestBody: createRequestBody(`${componentName}Create`),
        responses: { 201: createResponse('Created', createSchemaReference(componentName)), 400: createErrorResponse('Invalid request') },
        tags: [resource],
      },
    },
    [`/${resource}/{id}`]: {
      delete: {
        operationId: operationIds.remove,
        parameters: [createParameterReference('Id')],
        responses: { 200: createResponse('Deleted', createSchemaReference(componentName)), 404: createErrorResponse('Not found') },
        tags: [resource],
      },
      get: {
        operationId: operationIds.get,
        parameters: [createParameterReference('Id'), createParameterReference('Embed')],
        responses: {
          200: createResponse('Successful response', createSchemaReference(componentName)),
          400: createErrorResponse('Invalid query'),
          404: createErrorResponse('Not found'),
        },
        tags: [resource],
      },
      patch: {
        operationId: operationIds.update,
        parameters: [createParameterReference('Id')],
        requestBody: createRequestBody(`${componentName}Update`),
        responses: {
          200: createResponse('Updated', createSchemaReference(componentName)),
          400: createErrorResponse('Invalid request'),
          404: createErrorResponse('Not found'),
        },
        tags: [resource],
      },
      put: {
        operationId: operationIds.replace,
        parameters: [createParameterReference('Id')],
        requestBody: createRequestBody(`${componentName}Create`),
        responses: {
          200: createResponse('Replaced', createSchemaReference(componentName)),
          400: createErrorResponse('Invalid request'),
          404: createErrorResponse('Not found'),
        },
        tags: [resource],
      },
    },
  };
};

const validateGeneratedNames = (resources: string[], componentNames: Record<string, string>, files: boolean): void => {
  const schemaOwners = new Map<string, string>([
    ['Error', 'встроенная схема ошибки'],
    ...(files
      ? [
          ['FileMetadata', 'встроенная схема метаданных файла'],
          ['FileUpdate', 'встроенная схема изменения файла'],
        ]
      : []),
  ] as Array<[string, string]>);
  resources.forEach((resource) => {
    const componentName = componentNames[resource];

    if (componentName === '') {
      throw new Error(`Не удалось сформировать имя OpenAPI-схемы для ресурса «${resource}». Укажите $schema.${resource}.name`);
    }

    [componentName, `${componentName}Create`, `${componentName}Update`, `${componentName}Page`].forEach((schemaName) => {
      const owner = schemaOwners.get(schemaName);

      if (owner != null) {
        throw new Error(`Имя OpenAPI-схемы «${schemaName}» используется ресурсами «${owner}» и «${resource}». Укажите уникальный $schema.${resource}.name`);
      }

      schemaOwners.set(schemaName, resource);
    });
  });
};

const validateOperationIds = (paths: Record<string, OpenapiObject>): void => {
  const operationOwners = new Map<string, string>();

  Object.entries(paths).forEach(([path, pathItem]) => {
    Object.entries(pathItem).forEach(([method, operation]) => {
      if (!isObject(operation) || typeof operation.operationId !== 'string') {
        return;
      }

      const owner = operationOwners.get(operation.operationId);

      if (owner != null) {
        throw new Error(`operationId «${operation.operationId}» используется операциями «${owner}» и «${method.toUpperCase()} ${path}»`);
      }

      operationOwners.set(operation.operationId, `${method.toUpperCase()} ${path}`);
    });
  });
};

/** Builds an OpenAPI document without runtime server addresses. */
export function buildOpenapiDocument(options: BuildOpenapiOptions): OpenapiDocument {
  const { database, files = false, maxPageSize = DEFAULT_MAX_PAGE_SIZE, schema: schemaConfig = {} } = options ?? {};

  if (typeof files !== 'boolean') {
    throw new Error('Ключ files должен содержать boolean');
  }

  validateDatabase(database);

  if (!Number.isInteger(maxPageSize) || maxPageSize < 1) {
    throw new Error('Максимальный размер страницы должен быть положительным целым числом');
  }

  if (!isObject(schemaConfig)) {
    throw new Error('Схема базы данных должна содержать JSON-объект');
  }

  const resources = getResourceNames(database);
  const resourceConfigs = normalizeSchemaConfig(schemaConfig, resources);
  const componentNames: Record<string, string> = Object.fromEntries(
    resources.map((resource) => {
      const resourceConfig = resourceConfigs[resource];
      const componentName = resourceConfig.name ?? toPascalCase(singularize(resource));

      return [resource, componentName];
    }),
  );

  validateGeneratedNames(resources, componentNames, files);

  const rawSchemas: SchemaMap = Object.fromEntries(
    resources.map((resource) => {
      const resourceConfig = resourceConfigs[resource];
      const inferredSchema: OpenapiSchema = database[resource].length === 0 ? { properties: { id: { type: 'string' } }, type: 'object' } : inferObjectSchema(database[resource]);
      const configuredSchema = mergeSchemaOverrides(inferredSchema, { properties: resourceConfig.properties });

      return [resource, applyConfiguredFields(ensureGeneratedIdSchema(configuredSchema), resource, resourceConfig)];
    }),
  );
  const schemas: SchemaMap = {
    Error: { properties: { error: { type: 'string' } }, required: ['error'], type: 'object' },
    ...(files && {
      FileMetadata: FILE_METADATA_SCHEMA,
      FileUpdate: FILE_UPDATE_SCHEMA,
    }),
  };

  resources.forEach((resource) => {
    const componentName = componentNames[resource];
    const rawSchema = rawSchemas[resource];

    schemas[componentName] = addForwardRelations(rawSchema, resources, componentNames, resource);
    schemas[`${componentName}Create`] = omitId(rawSchema, true);
    schemas[`${componentName}Update`] = omitId(rawSchema, false);
    schemas[`${componentName}Page`] = {
      properties: {
        data: { items: createSchemaReference(componentName), type: 'array' },
        total: { minimum: 0, type: 'integer' },
      },
      required: ['data', 'total'],
      type: 'object',
    };
  });

  addReverseRelations(schemas, rawSchemas, resources, componentNames);

  const paths: Record<string, OpenapiObject> = Object.assign({}, ...resources.map((resource) => createResourcePaths(resource, componentNames[resource])), files ? createFilePaths() : {});

  validateOperationIds(paths);

  return {
    components: { parameters: createParameters(maxPageSize), schemas },
    info: isObject(schemaConfig.$info) ? (schemaConfig.$info as JsonObject) : { title: 'Deep JSON Server API', version: '1.0.0' },
    openapi: '3.0.3',
    paths,
    tags: [...new Set([...resources, ...(files ? ['files'] : [])])].map((name) => ({ name })),
  };
}
