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

const getServerUrl = (host, port) => {
  const serverPort = Number(port);

  if (typeof host !== 'string' || host === '') {
    throw new Error('Адрес сервера не должен быть пустым');
  }

  if (!Number.isInteger(serverPort) || serverPort < 1 || serverPort > 65_535) {
    throw new Error('Порт должен быть целым числом от 1 до 65535');
  }

  const serverHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;

  return `http://${serverHost}:${serverPort}`;
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

const mergeSchemaOverrides = (schema, overrides) => {
  if (!isObject(overrides)) {
    return schema;
  }

  const result = { ...schema, ...overrides };

  if (Object.hasOwn(overrides, 'type') && !Object.hasOwn(overrides, 'oneOf')) {
    delete result.oneOf;
  }

  if (isObject(schema.properties) || isObject(overrides.properties)) {
    const properties = isObject(schema.properties) ? { ...schema.properties } : {};

    Object.entries(isObject(overrides.properties) ? overrides.properties : {}).forEach(([key, value]) => {
      properties[key] = mergeSchemaOverrides(properties[key] ?? {}, value);
    });

    result.properties = properties;
  }

  if (isObject(schema.items) && isObject(overrides.items)) {
    result.items = mergeSchemaOverrides(schema.items, overrides.items);
  }

  return result;
};

const applyRequiredFields = (schema, path, requiredFields) => {
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map((nestedSchema) => applyRequiredFields(nestedSchema, path, requiredFields)) };
  }

  if (schema.type === 'array') {
    return { ...schema, items: applyRequiredFields(schema.items ?? {}, path, requiredFields) };
  }

  if (schema.type !== 'object' || !isObject(schema.properties)) {
    return schema;
  }

  const properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;

    return [key, applyRequiredFields(value, fieldPath, requiredFields)];
  }));
  const required = Object.keys(properties).filter((key) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;

    return path === '' && key === 'id' || requiredFields.has(fieldPath);
  });
  const result = { ...schema, properties };

  delete result.required;

  return required.length === 0 ? result : { ...result, required };
};

const inferSchema = (values) => {
  const schemas = [];
  const arrays = values.filter(Array.isArray);
  const objects = values.filter(isObject);

  if (arrays.length > 0) {
    const items = arrays.flat();

    schemas.push({ items: items.length === 0 ? {} : inferSchema(items), type: 'array' });
  }

  if (objects.length > 0) {
    schemas.push(inferObjectSchema(objects));
  }

  values.filter((value) => !Array.isArray(value) && !isObject(value)).forEach((value) => {
    if (value === null) {
      schemas.push({ type: 'null' });
      return;
    }

    if (typeof value === 'number') {
      schemas.push({ type: Number.isInteger(value) ? 'integer' : 'number' });
      return;
    }

    schemas.push({ type: typeof value });
  });

  return mergeSchemas(schemas);
};

function inferObjectSchema(values) {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))].sort((left, right) => left === 'id' ? -1 : right === 'id' ? 1 : left.localeCompare(right));
  const properties = Object.fromEntries(keys.map((key) => {
    const fieldValues = values.filter((value) => Object.hasOwn(value, key)).map((value) => value[key]);

    return [key, inferSchema(fieldValues)];
  }));

  return { properties, type: 'object' };
}

const resolveRelationResource = (resources, relation, sourceResource) => {
  const resource = resources.find((resourceName) => resourceName === relation) ?? resources.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return ['child', 'children', 'parent', 'parents'].includes(relation) ? sourceResource : undefined;
};

const addRelationSchemas = (schema, resources, componentNames, sourceResource) => {
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map((nestedSchema) => addRelationSchemas(nestedSchema, resources, componentNames, sourceResource)) };
  }

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
    const relationName = suffix === 'Ids' ? resources.find((resource) => singularize(resource) === relation) ?? `${relation}s` : relation;
    const targetResource = resolveRelationResource(resources, relationName, sourceResource);

    if (targetResource == null) {
      return;
    }

    const reference = { $ref: `#/components/schemas/${componentNames[targetResource]}` };

    properties[relationName] = suffix === 'Ids' ? { items: reference, type: 'array' } : reference;
  });

  return { ...schema, properties };
};

const getSchemasAtPath = (schema, keys) => {
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.flatMap((nestedSchema) => getSchemasAtPath(nestedSchema, keys));
  }

  if (schema.type === 'array') {
    return getSchemasAtPath(schema.items ?? {}, keys);
  }

  if (keys.length === 0) {
    return [schema];
  }

  if (schema.type !== 'object' || !isObject(schema.properties) || !Object.hasOwn(schema.properties, keys[0])) {
    return [];
  }

  return getSchemasAtPath(schema.properties[keys[0]], keys.slice(1));
};

const updateSchemasAtPath = (schema, keys, update) => {
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map((nestedSchema) => updateSchemasAtPath(nestedSchema, keys, update)) };
  }

  if (schema.type === 'array') {
    return { ...schema, items: updateSchemasAtPath(schema.items ?? {}, keys, update) };
  }

  if (keys.length === 0) {
    return update(schema);
  }

  if (schema.type !== 'object' || !isObject(schema.properties) || !Object.hasOwn(schema.properties, keys[0])) {
    return schema;
  }

  return {
    ...schema,
    properties: {
      ...schema.properties,
      [keys[0]]: updateSchemasAtPath(schema.properties[keys[0]], keys.slice(1), update),
    },
  };
};

const validateSchemaOverride = (schema, path) => {
  if (!isObject(schema)) {
    throw new Error(`OpenAPI-схема свойства «${path}» должна содержать JSON-объект`);
  }

  if (schema.properties != null) {
    if (!isObject(schema.properties)) {
      throw new Error(`properties свойства «${path}» должен содержать JSON-объект`);
    }

    Object.entries(schema.properties).forEach(([key, value]) => validateSchemaOverride(value, `${path}.${key}`));
  }

  if (schema.items != null) {
    validateSchemaOverride(schema.items, `${path}[]`);
  }

  if (schema.oneOf != null) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new Error(`oneOf свойства «${path}» должен содержать непустой массив`);
    }

    schema.oneOf.forEach((value, index) => validateSchemaOverride(value, `${path}.oneOf[${index}]`));
  }
};

const validateSchemaConfig = (schemaConfig, resources) => {
  if (Object.hasOwn(schemaConfig, '$info')) {
    if (!isObject(schemaConfig.$info) || !['title', 'version'].every((key) => typeof schemaConfig.$info[key] === 'string' && schemaConfig.$info[key].trim() !== '')) {
      throw new Error('$info должен содержать непустые строковые поля title и version');
    }
  }

  if (Object.hasOwn(schemaConfig, '$schema') && !isObject(schemaConfig.$schema)) {
    throw new Error('$schema должен содержать JSON-объект');
  }

  const resourceConfigs = schemaConfig.$schema ?? {};

  Object.entries(resourceConfigs).forEach(([resource, resourceConfig]) => {
    if (!resources.includes(resource)) {
      throw new Error(`В $schema указан неизвестный ресурс «${resource}»`);
    }

    if (!isObject(resourceConfig)) {
      throw new Error(`Настройки ресурса «${resource}» должны содержать JSON-объект`);
    }

    if (resourceConfig.name != null && (typeof resourceConfig.name !== 'string' || resourceConfig.name.trim() === '')) {
      throw new Error(`$schema.${resource}.name должен содержать непустую строку`);
    }

    if (resourceConfig.required != null && (!Array.isArray(resourceConfig.required) || resourceConfig.required.some((path) => typeof path !== 'string' || path === ''))) {
      throw new Error(`$schema.${resource}.required должен содержать массив непустых строк`);
    }

    if (resourceConfig.formats != null && (!isObject(resourceConfig.formats) || Object.entries(resourceConfig.formats).some(([path, format]) => path === '' || typeof format !== 'string' || format === ''))) {
      throw new Error(`$schema.${resource}.formats должен содержать JSON-объект с непустыми строковыми путями и форматами`);
    }

    if (resourceConfig.properties != null) {
      if (!isObject(resourceConfig.properties)) {
        throw new Error(`$schema.${resource}.properties должен содержать JSON-объект`);
      }

      Object.entries(resourceConfig.properties).forEach(([key, value]) => validateSchemaOverride(value, `${resource}.${key}`));
    }
  });

  return resourceConfigs;
};

const applyConfiguredFields = (schema, resource, resourceConfig) => {
  const requiredFields = Array.isArray(resourceConfig.required) ? resourceConfig.required : [];
  const formats = isObject(resourceConfig.formats) ? resourceConfig.formats : {};

  [...requiredFields, ...Object.keys(formats)].forEach((path) => {
    if (getSchemasAtPath(schema, path.split('.')).length === 0) {
      throw new Error(`Путь «${path}» из настроек ресурса «${resource}» отсутствует в итоговой схеме`);
    }
  });

  const schemaWithFormats = Object.entries(formats).reduce((result, [path, format]) => {
    const schemas = getSchemasAtPath(result, path.split('.'));

    if (!schemas.some((nestedSchema) => nestedSchema.type === 'string')) {
      throw new Error(`Формат «${format}» для пути «${resource}.${path}» можно применить только к строковому полю`);
    }

    return updateSchemasAtPath(result, path.split('.'), (nestedSchema) => nestedSchema.type === 'string' ? { ...nestedSchema, format } : nestedSchema);
  }, schema);

  return applyRequiredFields(schemaWithFormats, '', new Set(requiredFields));
};

const omitId = (schema, keepRequired) => {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'id'));
  const required = keepRequired ? schema.required?.filter((key) => key !== 'id') : undefined;

  const result = { ...schema, properties };

  delete result.required;

  return required?.length > 0 ? { ...result, required } : result;
};

const createParameters = () => ({
  Embed: { description: 'Relationship paths to embed', explode: true, in: 'query', name: '_embed', schema: { items: { type: 'string' }, type: 'array' }, style: 'form' },
  Id: { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
  Page: { in: 'query', name: '_page', required: false, schema: { default: 1, minimum: 1, type: 'integer' } },
  PerPage: { in: 'query', name: '_perPage', required: false, schema: { default: 10, minimum: 1, type: 'integer' } },
  Sort: { description: 'Comma-separated fields; prefix with - for descending order', in: 'query', name: '_sort', schema: { type: 'string' } },
  Where: { description: 'JSON-encoded deep filter', in: 'query', name: '_where', schema: { type: 'string' } },
});

const jsonContent = (schema) => ({ content: { 'application/json': { schema } } });
const response = (description, schema) => ({ description, ...(schema != null && jsonContent(schema)) });
const reference = (name) => ({ $ref: `#/components/schemas/${name}` });
const parameter = (name) => ({ $ref: `#/components/parameters/${name}` });

const createResourcePaths = (resource, componentName) => {
  const resourceName = toPascalCase(resource);
  const body = (name) => ({ required: true, ...jsonContent(reference(name)) });

  return {
    [`/${resource}`]: {
      get: {
        operationId: `get${resourceName}`,
        parameters: ['Page', 'PerPage', 'Sort', 'Where', 'Embed'].map(parameter),
        responses: { 200: response('Successful response', reference(`${componentName}Page`)), 400: response('Invalid query', reference('Error')) },
        tags: [resource],
      },
      post: {
        operationId: `post${resourceName}`,
        requestBody: body(`${componentName}Create`),
        responses: { 201: response('Created', reference(componentName)), 400: response('Invalid request', reference('Error')) },
        tags: [resource],
      },
    },
    [`/${resource}/{id}`]: {
      delete: {
        operationId: `delete${resourceName}ById`,
        parameters: [parameter('Id')],
        responses: { 200: response('Deleted', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [resource],
      },
      get: {
        operationId: `get${resourceName}ById`,
        parameters: [parameter('Id'), parameter('Embed')],
        responses: { 200: response('Successful response', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [resource],
      },
      patch: {
        operationId: `patch${resourceName}ById`,
        parameters: [parameter('Id')],
        requestBody: body(`${componentName}Update`),
        responses: { 200: response('Updated', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [resource],
      },
      put: {
        operationId: `put${resourceName}ById`,
        parameters: [parameter('Id')],
        requestBody: body(`${componentName}Create`),
        responses: { 200: response('Replaced', reference(componentName)), 404: response('Not found', reference('Error')) },
        tags: [resource],
      },
    },
  };
};

const getOperationIds = (resource) => {
  const resourceName = toPascalCase(resource);

  return [`get${resourceName}`, `post${resourceName}`, `delete${resourceName}ById`, `get${resourceName}ById`, `patch${resourceName}ById`, `put${resourceName}ById`];
};

const validateGeneratedNames = (resources, componentNames) => {
  const schemaOwners = new Map([['Error', 'встроенная схема ошибки']]);
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

    getOperationIds(resource).forEach((operationId) => {
      const owner = operationOwners.get(operationId);

      if (owner != null) {
        throw new Error(`operationId «${operationId}» используется ресурсами «${owner}» и «${resource}». Переименуйте один из ресурсов`);
      }

      operationOwners.set(operationId, resource);
    });
  });
};

export function createOpenApiDocument(database, schemaConfig = {}, { host = '127.0.0.1', port = 4001 } = {}) {
  if (!isObject(database) || !isObject(schemaConfig)) {
    throw new Error('База данных и её схема должны содержать JSON-объекты');
  }

  const resources = getResourceNames(database);
  const resourceConfigs = validateSchemaConfig(schemaConfig, resources);
  const componentNames = Object.fromEntries(resources.map((resource) => {
    const resourceConfig = isObject(resourceConfigs[resource]) ? resourceConfigs[resource] : {};
    const componentName = typeof resourceConfig.name === 'string' && resourceConfig.name !== '' ? resourceConfig.name : toPascalCase(singularize(resource));

    return [resource, componentName];
  }));

  validateGeneratedNames(resources, componentNames);

  const schemas = {
    Error: { properties: { error: { type: 'string' } }, required: ['error'], type: 'object' },
  };

  resources.forEach((resource) => {
    const componentName = componentNames[resource];
    const resourceConfig = isObject(resourceConfigs[resource]) ? resourceConfigs[resource] : {};
    const values = database[resource].filter(isObject);
    const inferredSchema = values.length === 0 ? { properties: { id: { type: 'string' } }, type: 'object' } : inferObjectSchema(values);
    const rawSchema = applyConfiguredFields(mergeSchemaOverrides(inferredSchema, { properties: isObject(resourceConfig.properties) ? resourceConfig.properties : {} }), resource, resourceConfig);
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
    servers: [{ url: getServerUrl(host, port) }],
    tags: resources.map((resource) => ({ name: resource })),
  };
}

export async function generateOpenApi({ databasePath, host, outputPath, port, schemaPath }) {
  const database = await readJson(databasePath, 'База данных');
  const schemaConfig = await readJson(schemaPath, 'Схема базы данных');
  const document = createOpenApiDocument(database, schemaConfig, { host, port });
  const resolvedOutputPath = resolve(outputPath);

  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(resolvedOutputPath, stringify(document, { aliasDuplicateObjects: false, lineWidth: 0 }), 'utf8');

  return document;
}
