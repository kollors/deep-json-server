import type { DatabaseSchema } from '../config.js';
import { readJsonObjectFile, validateJsonValue } from '../database.js';
import type { JsonObject, OpenapiSchema } from '../types.js';
import { assertKnownKeys, isObject } from '../utils.js';
import { applyRequiredFields, getSchemasAtPath, updateSchemasAtPath } from './inference.js';

const SCHEMA_CONFIG_KEYS = new Set(['$info', '$schema']);
const RESOURCE_CONFIG_KEYS = new Set(['formats', 'name', 'properties', 'required']);
const OPENAPI_TYPES = new Set(['array', 'boolean', 'integer', 'number', 'object', 'string']);
const COMPONENT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const SCHEMA_OVERRIDE_KEYS = new Set([
  '$ref',
  'additionalProperties',
  'allOf',
  'anyOf',
  'default',
  'deprecated',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maximum',
  'maxItems',
  'maxLength',
  'minimum',
  'minItems',
  'minLength',
  'not',
  'nullable',
  'oneOf',
  'pattern',
  'properties',
  'readOnly',
  'required',
  'title',
  'type',
  'uniqueItems',
  'writeOnly',
]);
const STRING_SCHEMA_KEYS = ['description', 'format', 'pattern', 'title'] as const;
const NUMBER_SCHEMA_KEYS = ['maximum', 'minimum'] as const;
const INTEGER_SCHEMA_KEYS = ['maxItems', 'maxLength', 'minItems', 'minLength'] as const;
const BOOLEAN_SCHEMA_KEYS = ['deprecated', 'nullable', 'readOnly', 'uniqueItems', 'writeOnly'] as const;

export interface ResourceSchemaConfig {
  formats: Record<string, string>;
  name?: string;
  properties: Record<string, OpenapiSchema>;
  required: string[];
}

function validateSchemaOverride(schema: unknown, path: string): asserts schema is OpenapiSchema {
  if (!isObject(schema)) {
    throw new Error(`OpenAPI-схема свойства «${path}» должна содержать JSON-объект`);
  }

  assertKnownKeys(schema, SCHEMA_OVERRIDE_KEYS, `properties.${path}`);

  if (schema.type != null && (typeof schema.type !== 'string' || !OPENAPI_TYPES.has(schema.type))) {
    throw new Error(`type свойства «${path}» должен содержать поддерживаемый тип OpenAPI`);
  }

  if (schema.required != null && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string' || key === ''))) {
    throw new Error(`required свойства «${path}» должен содержать массив непустых строк`);
  }

  if (schema.$ref != null && (typeof schema.$ref !== 'string' || schema.$ref === '')) {
    throw new Error(`$ref свойства «${path}» должен содержать непустую строку`);
  }

  STRING_SCHEMA_KEYS.forEach((key) => {
    if (schema[key] != null && typeof schema[key] !== 'string') {
      throw new Error(`${key} свойства «${path}» должен содержать строку`);
    }
  });

  NUMBER_SCHEMA_KEYS.forEach((key) => {
    if (schema[key] != null && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) {
      throw new Error(`${key} свойства «${path}» должен содержать конечное число`);
    }
  });

  INTEGER_SCHEMA_KEYS.forEach((key) => {
    if (schema[key] != null && (typeof schema[key] !== 'number' || !Number.isInteger(schema[key]) || schema[key] < 0)) {
      throw new Error(`${key} свойства «${path}» должен содержать неотрицательное целое число`);
    }
  });

  BOOLEAN_SCHEMA_KEYS.forEach((key) => {
    if (schema[key] != null && typeof schema[key] !== 'boolean') {
      throw new Error(`${key} свойства «${path}» должен содержать boolean`);
    }
  });

  if (schema.enum != null && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new Error(`enum свойства «${path}» должен содержать непустой массив`);
  }

  if (schema.properties != null) {
    if (!isObject(schema.properties)) {
      throw new Error(`properties свойства «${path}» должен содержать JSON-объект`);
    }

    Object.entries(schema.properties).forEach(([key, value]) => {
      validateSchemaOverride(value, `${path}.${key}`);
    });
  }

  if (schema.items != null) {
    validateSchemaOverride(schema.items, `${path}[]`);
  }

  for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[keyword] != null) {
      if (!Array.isArray(schema[keyword]) || schema[keyword].length === 0) {
        throw new Error(`${keyword} свойства «${path}» должен содержать непустой массив`);
      }

      schema[keyword].forEach((value, index) => {
        validateSchemaOverride(value, `${path}.${keyword}[${index}]`);
      });
    }
  }

  if (schema.not != null) {
    validateSchemaOverride(schema.not, `${path}.not`);
  }

  if (schema.additionalProperties != null && typeof schema.additionalProperties !== 'boolean') {
    validateSchemaOverride(schema.additionalProperties, `${path}.additionalProperties`);
  }

  if (schema.type != null) {
    const objectKeywords = ['additionalProperties', 'properties', 'required'];
    const arrayKeywords = ['items', 'maxItems', 'minItems', 'uniqueItems'];
    const stringKeywords = ['maxLength', 'minLength', 'pattern'];
    const numberKeywords = ['maximum', 'minimum'];
    const incompatibleKeyword = [
      ...(schema.type === 'object' ? [] : objectKeywords),
      ...(schema.type === 'array' ? [] : arrayKeywords),
      ...(schema.type === 'string' ? [] : stringKeywords),
      ...(['integer', 'number'].includes(schema.type) ? [] : numberKeywords),
    ].find((key) => schema[key] != null);

    if (incompatibleKeyword != null) {
      throw new Error(`${incompatibleKeyword} свойства «${path}» несовместим с type «${schema.type}»`);
    }
  }
}

export const normalizeSchemaConfig = (schemaConfig: JsonObject, resources: string[]): Record<string, ResourceSchemaConfig> => {
  validateJsonValue(schemaConfig, 'Схема базы данных');
  assertKnownKeys(schemaConfig, SCHEMA_CONFIG_KEYS, 'schema');
  const info = schemaConfig.$info;
  const normalizedInfo = isObject(info) ? (info as JsonObject) : undefined;

  if (Object.hasOwn(schemaConfig, '$info') && (normalizedInfo == null || !['title', 'version'].every((key) => typeof normalizedInfo[key] === 'string' && normalizedInfo[key].trim() !== ''))) {
    throw new Error('$info должен содержать непустые строковые поля title и version');
  }

  if (Object.hasOwn(schemaConfig, '$schema') && !isObject(schemaConfig.$schema)) {
    throw new Error('$schema должен содержать JSON-объект');
  }

  const resourceConfigs = (schemaConfig.$schema ?? {}) as Record<string, unknown>;

  Object.entries(resourceConfigs).forEach(([resource, resourceConfig]) => {
    if (!resources.includes(resource)) {
      throw new Error(`В $schema указан неизвестный ресурс «${resource}»`);
    }

    if (!isObject(resourceConfig)) {
      throw new Error(`Настройки ресурса «${resource}» должны содержать JSON-объект`);
    }

    assertKnownKeys(resourceConfig, RESOURCE_CONFIG_KEYS, `$schema.${resource}`);

    if (resourceConfig.name != null && (typeof resourceConfig.name !== 'string' || !COMPONENT_NAME_PATTERN.test(resourceConfig.name))) {
      throw new Error(`$schema.${resource}.name должен соответствовать шаблону ${COMPONENT_NAME_PATTERN}`);
    }

    if (resourceConfig.required != null && (!Array.isArray(resourceConfig.required) || resourceConfig.required.some((path) => typeof path !== 'string' || path === ''))) {
      throw new Error(`$schema.${resource}.required должен содержать массив непустых строк`);
    }

    if (
      resourceConfig.formats != null &&
      (!isObject(resourceConfig.formats) || Object.entries(resourceConfig.formats).some(([path, format]) => path === '' || typeof format !== 'string' || format === ''))
    ) {
      throw new Error(`$schema.${resource}.formats должен содержать JSON-объект с непустыми строковыми путями и форматами`);
    }

    if (resourceConfig.properties != null) {
      if (!isObject(resourceConfig.properties)) {
        throw new Error(`$schema.${resource}.properties должен содержать JSON-объект`);
      }

      Object.entries(resourceConfig.properties).forEach(([key, value]) => {
        validateSchemaOverride(value, `${resource}.${key}`);
      });
    }
  });

  return Object.fromEntries(
    resources.map((resource) => {
      const resourceConfig = (resourceConfigs[resource] ?? {}) as Record<string, unknown>;

      return [
        resource,
        {
          formats: (resourceConfig.formats ?? {}) as Record<string, string>,
          name: typeof resourceConfig.name === 'string' ? resourceConfig.name : undefined,
          properties: (resourceConfig.properties ?? {}) as Record<string, OpenapiSchema>,
          required: (resourceConfig.required ?? []) as string[],
        },
      ];
    }),
  );
};

export const applyConfiguredFields = (schema: OpenapiSchema, resource: string, resourceConfig: ResourceSchemaConfig): OpenapiSchema => {
  const { formats, required: requiredFields } = resourceConfig;

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

    return updateSchemasAtPath(result, path.split('.'), (nestedSchema) => (nestedSchema.type === 'string' ? { ...nestedSchema, format } : nestedSchema));
  }, schema);

  return applyRequiredFields(schemaWithFormats, '', new Set(requiredFields));
};

export const resolveSchemaConfig = async (schema: DatabaseSchema | string | undefined): Promise<DatabaseSchema> => {
  if (schema == null) {
    return {};
  }

  if (typeof schema === 'string') {
    return (await readJsonObjectFile(schema, 'Файл схемы базы данных')) as DatabaseSchema;
  }

  if (!isObject(schema)) {
    throw new Error('Схема базы данных должна содержать JSON-объект');
  }

  const clonedSchema = structuredClone(schema);

  validateJsonValue(clonedSchema, 'Схема базы данных');

  return clonedSchema;
};
