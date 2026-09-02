import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from '../constants.js';
import { validateDatabase } from '../database.js';
import { getRelationMetadata } from '../relation-metadata.js';
import { getResourceNames, isObject, singularize, toPascalCase } from '../utils.js';
import { applyConfiguredFields, validateSchemaConfig } from './config.js';
import { ensureGeneratedIdSchema, inferObjectSchema, mergeSchemaOverrides, omitId } from './inference.js';

const createSchemaReference = (name) => ({ $ref: `#/components/schemas/${name}` });

const addForwardRelations = (schema, resources, componentNames, sourceResource) => {
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

const collectRelations = (schema, resources, sourceResource, relations = []) => {
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

const addReverseRelations = (schemas, rawSchemas, resources, componentNames) => {
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

const createParameters = (maxPageSize) => ({
  ContentName: { description: 'URI-encoded relative file name', in: 'header', name: 'Content-Name', required: true, schema: { type: 'string' } },
  Embed: { description: 'Relationship paths to embed', explode: true, in: 'query', name: '_embed', schema: { items: { type: 'string' }, type: 'array' }, style: 'form' },
  Id: { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
  Page: { in: 'query', name: '_page', required: false, schema: { default: 1, minimum: 1, type: 'integer' } },
  PerPage: { in: 'query', name: '_perPage', required: false, schema: { default: DEFAULT_PAGE_SIZE, maximum: maxPageSize, minimum: 1, type: 'integer' } },
  Sort: { description: 'Comma-separated fields; prefix with - for descending order', in: 'query', name: '_sort', schema: { type: 'string' } },
  Where: { description: 'JSON-encoded deep filter', in: 'query', name: '_where', schema: { type: 'string' } },
});

const createJsonContent = (schema) => ({ content: { 'application/json': { schema } } });
const createResponse = (description, schema) => ({ description, ...(schema != null && createJsonContent(schema)) });
const createParameterReference = (name) => ({ $ref: `#/components/parameters/${name}` });
const createRequestBody = (name) => ({ required: true, ...createJsonContent(createSchemaReference(name)) });

const createFilePaths = () => ({
  '/_files': {
    post: {
      operationId: 'uploadFile',
      parameters: [createParameterReference('ContentName')],
      requestBody: { content: { 'application/octet-stream': { schema: { format: 'binary', type: 'string' } } }, required: true },
      responses: {
        201: createResponse('Uploaded', createSchemaReference('UploadedFile')),
        400: createResponse('Invalid request', createSchemaReference('Error')),
        413: createResponse('File is too large', createSchemaReference('Error')),
        415: createResponse('Unsupported media type', createSchemaReference('Error')),
      },
      tags: ['files'],
    },
  },
  '/_files/{id}': {
    delete: {
      operationId: 'deleteFileById',
      parameters: [createParameterReference('Id')],
      responses: { 200: createResponse('Deleted', createSchemaReference('UploadedFile')), 404: createResponse('Not found', createSchemaReference('Error')) },
      tags: ['files'],
    },
    get: {
      operationId: 'getFileById',
      parameters: [createParameterReference('Id')],
      responses: {
        200: { content: { 'application/octet-stream': { schema: { format: 'binary', type: 'string' } } }, description: 'File contents' },
        404: createResponse('Not found', createSchemaReference('Error')),
      },
      tags: ['files'],
    },
  },
});

const createResourceOperationIds = (resource) => {
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

const createResourcePaths = (resource, componentName) => {
  const operationIds = createResourceOperationIds(resource);

  return {
    [`/${resource}`]: {
      get: {
        operationId: operationIds.list,
        parameters: ['Page', 'PerPage', 'Sort', 'Where', 'Embed'].map(createParameterReference),
        responses: { 200: createResponse('Successful response', createSchemaReference(`${componentName}Page`)), 400: createResponse('Invalid query', createSchemaReference('Error')) },
        tags: [resource],
      },
      post: {
        operationId: operationIds.create,
        requestBody: createRequestBody(`${componentName}Create`),
        responses: { 201: createResponse('Created', createSchemaReference(componentName)), 400: createResponse('Invalid request', createSchemaReference('Error')) },
        tags: [resource],
      },
    },
    [`/${resource}/{id}`]: {
      delete: {
        operationId: operationIds.remove,
        parameters: [createParameterReference('Id')],
        responses: { 200: createResponse('Deleted', createSchemaReference(componentName)), 404: createResponse('Not found', createSchemaReference('Error')) },
        tags: [resource],
      },
      get: {
        operationId: operationIds.get,
        parameters: [createParameterReference('Id'), createParameterReference('Embed')],
        responses: {
          200: createResponse('Successful response', createSchemaReference(componentName)),
          400: createResponse('Invalid query', createSchemaReference('Error')),
          404: createResponse('Not found', createSchemaReference('Error')),
        },
        tags: [resource],
      },
      patch: {
        operationId: operationIds.update,
        parameters: [createParameterReference('Id')],
        requestBody: createRequestBody(`${componentName}Update`),
        responses: {
          200: createResponse('Updated', createSchemaReference(componentName)),
          400: createResponse('Invalid request', createSchemaReference('Error')),
          404: createResponse('Not found', createSchemaReference('Error')),
        },
        tags: [resource],
      },
      put: {
        operationId: operationIds.replace,
        parameters: [createParameterReference('Id')],
        requestBody: createRequestBody(`${componentName}Create`),
        responses: {
          200: createResponse('Replaced', createSchemaReference(componentName)),
          400: createResponse('Invalid request', createSchemaReference('Error')),
          404: createResponse('Not found', createSchemaReference('Error')),
        },
        tags: [resource],
      },
    },
  };
};

const validateGeneratedNames = (resources, componentNames, files) => {
  const schemaOwners = new Map([['Error', 'встроенная схема ошибки'], ...(files ? [['UploadedFile', 'встроенная схема файла']] : [])]);
  const operationOwners = new Map();

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

    Object.values(createResourceOperationIds(resource)).forEach((operationId) => {
      const owner = operationOwners.get(operationId);

      if (owner != null) {
        throw new Error(`operationId «${operationId}» используется ресурсами «${owner}» и «${resource}». Переименуйте один из ресурсов`);
      }

      operationOwners.set(operationId, resource);
    });
  });
};

/**
 * Builds an OpenAPI document without runtime server addresses.
 * @param {{ database: Record<string, Array<Record<string, unknown>>>, files?: boolean, maxPageSize?: number, schema?: Record<string, unknown> }} options Source data and schema settings.
 * @returns {Record<string, unknown>} OpenAPI document.
 */
export function buildOpenapiDocument(options) {
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
  const resourceConfigs = validateSchemaConfig(schemaConfig, resources);
  const componentNames = Object.fromEntries(
    resources.map((resource) => {
      const resourceConfig = isObject(resourceConfigs[resource]) ? resourceConfigs[resource] : {};
      const componentName = typeof resourceConfig.name === 'string' && resourceConfig.name !== '' ? resourceConfig.name : toPascalCase(singularize(resource));

      return [resource, componentName];
    }),
  );

  validateGeneratedNames(resources, componentNames, files);

  const rawSchemas = Object.fromEntries(
    resources.map((resource) => {
      const resourceConfig = isObject(resourceConfigs[resource]) ? resourceConfigs[resource] : {};
      const inferredSchema = database[resource].length === 0 ? { properties: { id: { type: 'string' } }, type: 'object' } : inferObjectSchema(database[resource]);
      const configuredSchema = mergeSchemaOverrides(inferredSchema, { properties: isObject(resourceConfig.properties) ? resourceConfig.properties : {} });

      return [resource, applyConfiguredFields(ensureGeneratedIdSchema(configuredSchema), resource, resourceConfig)];
    }),
  );
  const schemas = {
    Error: { properties: { error: { type: 'string' } }, required: ['error'], type: 'object' },
    ...(files && {
      UploadedFile: {
        properties: { id: { type: 'string' }, mimeType: { type: 'string' }, name: { type: 'string' }, size: { minimum: 0, type: 'integer' }, url: { type: 'string' } },
        required: ['id', 'mimeType', 'name', 'size', 'url'],
        type: 'object',
      },
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

  return {
    components: { parameters: createParameters(maxPageSize), schemas },
    info: isObject(schemaConfig.$info) ? schemaConfig.$info : { title: 'Deep JSON Server API', version: '1.0.0' },
    openapi: '3.0.3',
    paths: Object.assign({}, ...resources.map((resource) => createResourcePaths(resource, componentNames[resource])), files ? createFilePaths() : {}),
    tags: [...resources.map((resource) => ({ name: resource })), ...(files ? [{ name: 'files' }] : [])],
  };
}
