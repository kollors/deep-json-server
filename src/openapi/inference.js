import { isObject } from '../utils.js';

export const mergeSchemas = (schemas) => {
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

export const mergeSchemaOverrides = (schema, overrides) => {
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

export const applyRequiredFields = (schema, path, requiredFields) => {
  if (Array.isArray(schema.oneOf)) {
    return { ...schema, oneOf: schema.oneOf.map((nestedSchema) => applyRequiredFields(nestedSchema, path, requiredFields)) };
  }

  if (schema.type === 'array') {
    return { ...schema, items: applyRequiredFields(schema.items ?? {}, path, requiredFields) };
  }

  if (schema.type !== 'object' || !isObject(schema.properties)) {
    return schema;
  }

  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => {
      const fieldPath = path === '' ? key : `${path}.${key}`;

      return [key, applyRequiredFields(value, fieldPath, requiredFields)];
    }),
  );
  const required = Object.keys(properties).filter((key) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;

    return (path === '' && key === 'id') || requiredFields.has(fieldPath);
  });
  const result = { ...schema, properties };

  delete result.required;

  return required.length === 0 ? result : { ...result, required };
};

export const inferSchema = (values) => {
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

  values
    .filter((value) => !Array.isArray(value) && !isObject(value))
    .forEach((value) => {
      if (value === null) {
        schemas.push({ type: 'null' });
      } else if (typeof value === 'number') {
        schemas.push({ type: Number.isInteger(value) ? 'integer' : 'number' });
      } else {
        schemas.push({ type: typeof value });
      }
    });

  return mergeSchemas(schemas);
};

export function inferObjectSchema(values) {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))].sort((left, right) => (left === 'id' ? -1 : right === 'id' ? 1 : left.localeCompare(right)));
  const properties = Object.fromEntries(
    keys.map((key) => {
      const fieldValues = values.filter((value) => Object.hasOwn(value, key)).map((value) => value[key]);

      return [key, inferSchema(fieldValues)];
    }),
  );

  return { properties, type: 'object' };
}

export const ensureGeneratedIdSchema = (schema) => {
  const idSchema = schema.properties?.id ?? {};
  const idSchemas = Array.isArray(idSchema.oneOf) ? idSchema.oneOf : [idSchema];
  const properties = {
    ...schema.properties,
    id: idSchemas.some(({ type }) => type === 'string') ? idSchema : { oneOf: [...idSchemas, { type: 'string' }] },
  };

  return { ...schema, properties };
};

export const getSchemasAtPath = (schema, keys) => {
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

export const updateSchemasAtPath = (schema, keys, update) => {
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

export const omitId = (schema, keepRequired) => {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'id'));
  const required = keepRequired ? schema.required?.filter((key) => key !== 'id') : undefined;
  const result = { ...schema, properties };

  delete result.required;

  return required?.length > 0 ? { ...result, required } : result;
};
