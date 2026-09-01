import { readJsonObject } from '../database.js';
import { isObject } from '../utils.js';
import { applyRequiredFields, getSchemasAtPath, updateSchemasAtPath } from './inference.js';

const validateSchemaOverride = (schema, path) => {
  if (!isObject(schema)) {
    throw new Error(`OpenAPI-схема свойства «${path}» должна содержать JSON-объект`);
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

  if (schema.oneOf != null) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new Error(`oneOf свойства «${path}» должен содержать непустой массив`);
    }

    schema.oneOf.forEach((value, index) => {
      validateSchemaOverride(value, `${path}.oneOf[${index}]`);
    });
  }
};

export const validateSchemaConfig = (schemaConfig, resources) => {
  if (
    Object.hasOwn(schemaConfig, '$info') &&
    (!isObject(schemaConfig.$info) || !['title', 'version'].every((key) => typeof schemaConfig.$info[key] === 'string' && schemaConfig.$info[key].trim() !== ''))
  ) {
    throw new Error('$info должен содержать непустые строковые поля title и version');
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

  return resourceConfigs;
};

export const applyConfiguredFields = (schema, resource, resourceConfig) => {
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

    return updateSchemasAtPath(result, path.split('.'), (nestedSchema) => (nestedSchema.type === 'string' ? { ...nestedSchema, format } : nestedSchema));
  }, schema);

  return applyRequiredFields(schemaWithFormats, '', new Set(requiredFields));
};

export const readSchemaConfig = async (schemaPath) => (schemaPath == null ? {} : readJsonObject(schemaPath, 'Файл схемы базы данных'));
