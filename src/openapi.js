import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { stringify } from 'yaml';
import { getResourceNames, isObject, singularize, toPascalCase } from './utils.js';

const readJson = async(path, label) => {
  const value = JSON.parse(await readFile(resolve(path), 'utf8'));

  if (!isObject(value)) {
    throw new Error(`${label} должен содержать JSON-объект`);
  }

  return value;
};

const mergeSchemas = (schemas) => {
  const uniqueSchemas = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
  const nullable = uniqueSchemas.some((schema) => schema.type === 'null');
  const nonNullSchemas = uniqueSchemas.filter((schema) => schema.type !== 'null');

  if (nonNullSchemas.length === 0) {
    return { nullable: true };
  }

  if (nonNullSchemas.length === 1) {
    return nullable ? { ...nonNullSchemas[0], nullable: true } : nonNullSchemas[0];
  }

  return { oneOf: nonNullSchemas, ...(nullable && { nullable: true }) };
};

const inferSchema = (values, path, options) => {
  if (values.every(Array.isArray)) {
    const items = values.flat();

    return { items: items.length === 0 ? {} : inferSchema(items, path, options), type: 'array' };
  }

  if (values.every(isObject)) {
    return inferObjectSchema(values, path, options);
  }

  const schemas = values.map((value) => {
    if (value === null) {
      return { type: 'null' };
    }

    if (typeof value === 'number') {
      return { type: Number.isInteger(value) ? 'integer' : 'number' };
    }

    const schema = { type: typeof value };
    const format = options.formats[path];

    return typeof value === 'string' && format != null ? { ...schema, format } : schema;
  });

  return mergeSchemas(schemas);
};

function inferObjectSchema(values, path, options) {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))].sort((left, right) => left === 'id' ? -1 : right === 'id' ? 1 : left.localeCompare(right));
  const properties = Object.fromEntries(keys.map((key) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;
    const fieldValues = values.filter((value) => Object.hasOwn(value, key)).map((value) => value[key]);

    return [key, inferSchema(fieldValues, fieldPath, options)];
  }));
  const required = keys.filter((key) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;

    return !options.optional.has(fieldPath) && values.every((value) => Object.hasOwn(value, key));
  });

  return { properties, type: 'object', ...(required.length > 0 && { required }) };
}

const resolveRelationResource = (resources, relation, sourceResource) => {
  const resource = resources.find((resourceName) => resourceName === relation) ?? resources.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return ['child', 'children', 'parent', 'parents'].includes(relation) ? sourceResource : undefined;
};

const addRelationSchemas = (schema, resources, componentNames, sourceResource) => {
  if (schema.type === 'array') {
    return { ...schema, items: addRelationSchemas(schema.items, resources, componentNames, sourceResource) };
  }

  if (schema.type !== 'object' || schema.properties == null) {
    return schema;
  }

  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, addRelationSchemas(value, resources, componentNames, sourceResource)]));

  Object.keys(schema.properties).forEach((key) => {
    const match = key.match(/^(.+)(Id|Ids)$/);

    if (match == null) {
      return;
    }

    const [, relation, suffix] = match;
    const targetResource = resolveRelationResource(resources, suffix === 'Ids' ? `${relation}s` : relation, sourceResource);

    if (targetResource == null) {
      return;
    }

    const relationName = suffix === 'Ids' ? `${relation}s` : relation;
    const reference = { $ref: `#/components/schemas/${componentNames[targetResource]}` };

    properties[relationName] = suffix === 'Ids' ? { items: reference, type: 'array' } : reference;
  });

  return { ...schema, properties };
};

const omitId = (schema, keepRequired) => {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'id'));
  const required = keepRequired ? schema.required?.filter((key) => key !== 'id') : undefined;

  const result = { ...schema, properties };

  delete result.required;

  return required?.length > 0 ? { ...result, required } : result;
};

const createParameters = () => ({
  Embed: { description: 'Comma-separated relationship paths to embed', in: 'query', name: '_embed', schema: { type: 'string' } },
  Id: { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
  Page: { in: 'query', name: '_page', schema: { minimum: 1, type: 'integer' } },
  PerPage: { in: 'query', name: '_per_page', schema: { minimum: 1, type: 'integer' } },
  Sort: { description: 'Comma-separated fields; prefix with - for descending order', in: 'query', name: '_sort', schema: { type: 'string' } },
  Where: { description: 'JSON-encoded deep filter', in: 'query', name: '_where', schema: { type: 'string' } },
});

const jsonContent = (schema) => ({ content: { 'application/json': { schema } } });
const response = (description, schema) => ({ description, ...(schema != null && jsonContent(schema)) });
const reference = (name) => ({ $ref: `#/components/schemas/${name}` });
const parameter = (name) => ({ $ref: `#/components/parameters/${name}` });

const createResourcePaths = (resource, componentName) => {
  const tag = componentName;
  const listSchema = { oneOf: [{ items: reference(componentName), type: 'array' }, reference(`${componentName}Page`)] };
  const body = (name) => ({ required: true, ...jsonContent(reference(name)) });

  return {
    [`/${resource}`]: {
      get: {
        operationId: `get${toPascalCase(resource)}`,
        parameters: ['Page', 'PerPage', 'Sort', 'Where', 'Embed'].map(parameter),
        responses: { 200: response('Successful response', listSchema), 400: response('Invalid query', reference('Error')) },
        tags: [tag],
      },
      post: {
        operationId: `create${componentName}`,
        requestBody: body(`${componentName}Create`),
        responses: { 201: response('Created', reference(componentName)), 400: response('Invalid request', reference('Error')) },
        tags: [tag],
      },
    },
    [`/${resource}/{id}`]: {
      delete: {
        operationId: `delete${componentName}`,
        parameters: [parameter('Id')],
        responses: { 200: response('Deleted', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [tag],
      },
      get: {
        operationId: `get${componentName}ById`,
        parameters: [parameter('Id'), parameter('Embed')],
        responses: { 200: response('Successful response', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [tag],
      },
      patch: {
        operationId: `update${componentName}`,
        parameters: [parameter('Id')],
        requestBody: body(`${componentName}Update`),
        responses: { 200: response('Updated', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [tag],
      },
      put: {
        operationId: `replace${componentName}`,
        parameters: [parameter('Id')],
        requestBody: body(`${componentName}Create`),
        responses: { 200: response('Replaced', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [tag],
      },
    },
  };
};

export function createOpenApiDocument(database, schemaConfig = {}) {
  if (!isObject(database) || !isObject(schemaConfig)) {
    throw new Error('База данных и её схема должны содержать JSON-объекты');
  }

  const resources = getResourceNames(database);
  const componentNames = Object.fromEntries(resources.map((resource) => [resource, toPascalCase(singularize(resource))]));
  const schemas = {
    Error: { properties: { error: { type: 'string' } }, required: ['error'], type: 'object' },
  };

  resources.forEach((resource) => {
    const componentName = componentNames[resource];
    const resourceConfig = isObject(schemaConfig[resource]) ? schemaConfig[resource] : {};
    const options = {
      formats: isObject(resourceConfig.formats) ? resourceConfig.formats : {},
      optional: new Set(Array.isArray(resourceConfig.optional) ? resourceConfig.optional : []),
    };
    const values = database[resource].filter(isObject);
    const rawSchema = values.length === 0 ? { additionalProperties: true, type: 'object' } : inferObjectSchema(values, '', options);
    const responseSchema = addRelationSchemas(rawSchema, resources, componentNames, resource);

    schemas[componentName] = responseSchema;
    schemas[`${componentName}Create`] = omitId(rawSchema, true);
    schemas[`${componentName}Update`] = omitId(rawSchema, false);
    schemas[`${componentName}Page`] = {
      properties: {
        data: { items: reference(componentName), type: 'array' },
        first: { type: 'integer' },
        items: { type: 'integer' },
        last: { type: 'integer' },
        next: { nullable: true, type: 'integer' },
        pages: { type: 'integer' },
        prev: { nullable: true, type: 'integer' },
      },
      required: ['data', 'first', 'items', 'last', 'next', 'pages', 'prev'],
      type: 'object',
    };
  });

  return {
    components: { parameters: createParameters(), schemas },
    info: isObject(schemaConfig.$info) ? schemaConfig.$info : { title: 'Deep JSON Server API', version: '1.0.0' },
    openapi: '3.0.3',
    paths: Object.assign({}, ...resources.map((resource) => createResourcePaths(resource, componentNames[resource]))),
    servers: Array.isArray(schemaConfig.$servers) ? schemaConfig.$servers : [{ url: 'http://127.0.0.1:4001' }],
    tags: resources.map((resource) => ({ name: componentNames[resource] })),
  };
}

export async function generateOpenApi({ databasePath, outputPath, schemaPath }) {
  const database = await readJson(databasePath, 'База данных');
  const schemaConfig = await readJson(schemaPath, 'Схема базы данных');
  const document = createOpenApiDocument(database, schemaConfig);
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { lineWidth: 0 }), 'utf8');

  return document;
}
