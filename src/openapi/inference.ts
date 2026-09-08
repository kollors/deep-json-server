import type { JsonObject, JsonValue, OpenapiSchema } from '../types.js';
import { isObject } from '../utils.js';
import { COMPOSITION_KEYWORDS, mapCompositions } from './traversal.js';

type InferredSchema = Omit<OpenapiSchema, 'type'> & { type?: OpenapiSchema['type'] | 'null' };

export const mergeSchemas = (schemas: InferredSchema[]): OpenapiSchema => {
  const nullSchema: OpenapiSchema = { enum: [null], nullable: true, type: 'string' };
  const uniqueSchemas = [...new Map(schemas.map((schema) => [JSON.stringify(schema), schema])).values()];
  const nullable = uniqueSchemas.some((schema) => schema.type === 'null');
  let nonNullSchemas: OpenapiSchema[] = uniqueSchemas.filter((schema): schema is OpenapiSchema => schema.type !== 'null');

  if (nonNullSchemas.some((schema) => schema.type === 'number')) {
    nonNullSchemas = nonNullSchemas.filter((schema) => schema.type !== 'integer');
  }

  if (nonNullSchemas.length === 0) {
    return nullSchema;
  }

  if (nonNullSchemas.length === 1) {
    return nullable ? { ...nonNullSchemas[0], nullable: true } : nonNullSchemas[0];
  }

  if (nullable) {
    nonNullSchemas.push(nullSchema);
  }

  return { oneOf: nonNullSchemas };
};

export const mergeSchemaOverrides = (schema: OpenapiSchema, overrides: unknown): OpenapiSchema => {
  if (!isObject(overrides)) {
    return schema;
  }

  const result: OpenapiSchema = { ...schema, ...overrides };

  if (Object.hasOwn(overrides, 'type')) {
    if (!Object.hasOwn(overrides, 'oneOf')) {
      delete result.oneOf;
    }

    // An explicit type can widen an inferred null-only field; an explicit enum still wins.
    if (schema.type === 'string' && schema.nullable === true && schema.enum?.length === 1 && schema.enum[0] === null && !Object.hasOwn(overrides, 'enum')) {
      delete result.enum;
    }
  }

  if (isObject(schema.properties) || isObject(overrides.properties)) {
    const properties: Record<string, OpenapiSchema> = isObject(schema.properties) ? { ...schema.properties } : {};

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

export const applyRequiredFields = (schema: OpenapiSchema, path: string, requiredFields: Set<string>): OpenapiSchema => {
  const result = mapCompositions(schema, (nestedSchema) => applyRequiredFields(nestedSchema, path, requiredFields));

  if (schema.items != null) {
    result.items = applyRequiredFields(schema.items, path, requiredFields);
  }

  if (!isObject(schema.properties)) {
    return result;
  }

  const properties = Object.fromEntries(
    Object.entries(schema.properties).map(([key, value]) => {
      const fieldPath = path === '' ? key : `${path}.${key}`;

      return [key, applyRequiredFields(value, fieldPath, requiredFields)];
    }),
  );
  const required = new Set(schema.required);

  Object.keys(properties).forEach((key) => {
    const fieldPath = path === '' ? key : `${path}.${key}`;

    if ((path === '' && key === 'id') || requiredFields.has(fieldPath)) {
      required.add(key);
    }
  });

  return { ...result, properties, ...(required.size > 0 && { required: [...required] }) };
};

export const inferSchema = (values: JsonValue[]): OpenapiSchema => {
  const schemas: InferredSchema[] = [];
  const arrays = values.filter((value): value is JsonValue[] => Array.isArray(value));
  const objects = values.filter((value): value is JsonObject => isObject(value));

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
        schemas.push({ type: typeof value as 'boolean' | 'string' });
      }
    });

  return mergeSchemas(schemas);
};

export function inferObjectSchema(values: JsonObject[]): OpenapiSchema {
  const keys = [...new Set(values.flatMap((value) => Object.keys(value)))].sort((left, right) => (left === 'id' ? -1 : right === 'id' ? 1 : left.localeCompare(right)));
  const properties = Object.fromEntries(
    keys.map((key) => {
      const fieldValues = values.filter((value) => Object.hasOwn(value, key)).map((value) => value[key]);

      return [key, inferSchema(fieldValues)];
    }),
  );

  return { properties, type: 'object' };
}

export const ensureGeneratedIdSchema = (schema: OpenapiSchema): OpenapiSchema => {
  const idSchema = schema.properties?.id ?? {};
  const idSchemas = Array.isArray(idSchema.oneOf) ? idSchema.oneOf : [idSchema];
  const properties = {
    ...schema.properties,
    id: idSchemas.some(({ type }) => type === 'string') ? idSchema : { oneOf: [...idSchemas, { type: 'string' as const }] },
  };

  return { ...schema, properties };
};

export const getSchemasAtPath = (schema: OpenapiSchema, keys: string[]): OpenapiSchema[] => {
  const branches = COMPOSITION_KEYWORDS.flatMap((keyword) => schema[keyword]?.flatMap((nestedSchema) => getSchemasAtPath(nestedSchema, keys)) ?? []);

  if (schema.items != null) {
    return [...branches, ...getSchemasAtPath(schema.items, keys)];
  }

  if (keys.length === 0) {
    return [...branches, schema];
  }

  if (!isObject(schema.properties) || !Object.hasOwn(schema.properties, keys[0])) {
    return branches;
  }

  return [...branches, ...getSchemasAtPath(schema.properties[keys[0]], keys.slice(1))];
};

export const updateSchemasAtPath = (schema: OpenapiSchema, keys: string[], update: (schema: OpenapiSchema) => OpenapiSchema): OpenapiSchema => {
  const result = mapCompositions(schema, (nestedSchema) => updateSchemasAtPath(nestedSchema, keys, update));

  if (schema.items != null) {
    return { ...result, items: updateSchemasAtPath(schema.items, keys, update) };
  }

  if (keys.length === 0) {
    return update(result);
  }

  if (!isObject(schema.properties) || !Object.hasOwn(schema.properties, keys[0])) {
    return result;
  }

  return {
    ...result,
    properties: {
      ...schema.properties,
      [keys[0]]: updateSchemasAtPath(schema.properties[keys[0]], keys.slice(1), update),
    },
  };
};

export const omitId = (schema: OpenapiSchema, keepRequired: boolean): OpenapiSchema => {
  const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([key]) => key !== 'id'));
  const required = keepRequired ? schema.required?.filter((key) => key !== 'id') : undefined;
  const result = { ...schema, properties };

  delete result.required;

  return required != null && required.length > 0 ? { ...result, required } : result;
};
