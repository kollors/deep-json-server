import { AUTH_SCHEMAS, AUTH_SECURITY_SCHEMES, authOpenapiPaths } from '../auth/openapi.js';
import { VERSION } from '../constants.js';
import { FILE_HEADERS, FILE_METADATA_SCHEMA, FILE_UPDATE_SCHEMA } from '../files/http.js';
import { createFilePaths } from '../files/openapi.js';
import { assertApi, type Entity, type Model, type Node, nodeName, objectSchema, operationName, relationInputSchema, type ValidationSchema, valueSchema } from '../model.js';
import { normalizePagination } from '../pagination.js';
import { operatorsFor } from '../query/contract.js';
import { sortableFields } from '../query/options.js';
import type { OpenapiDocument, OpenapiSchema } from '../types.js';
import { isObject } from '../utils.js';

import { json, ref, response } from './helpers.js';

function toOpenapi(schema: ValidationSchema): OpenapiSchema {
  if (Array.isArray(schema.anyOf) && schema.anyOf.some((v) => isObject(v) && v.type === 'null')) {
    const nonNull = schema.anyOf.find((v) => isObject(v) && v.type !== 'null') as ValidationSchema;
    const converted = toOpenapi(nonNull);
    if (!converted.type) return { anyOf: [converted, { type: 'object', nullable: true, enum: [null] }] };
    return { ...converted, nullable: true, ...(converted.enum ? { enum: [...converted.enum.filter((value) => value !== null), null] } : {}) };
  }
  const result: Record<string, unknown> = { ...schema };
  if (isObject(schema.properties)) result.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toOpenapi(v as ValidationSchema)]));
  if (isObject(schema.items)) result.items = toOpenapi(schema.items);
  return result as OpenapiSchema;
}
export function buildOpenapiDocument({
  model,
  files = false,
  auth = false,
  pageSize,
  maxPageSize,
  info = { title: 'Deep JSON Server API', version: VERSION },
}: {
  model: Model;
  files?: boolean;
  auth?: boolean;
  pageSize?: number;
  maxPageSize?: number;
  info?: Record<string, unknown>;
}): OpenapiDocument {
  assertApi(model, 'openapi');
  ({ pageSize, maxPageSize } = normalizePagination({ pageSize, maxPageSize }));
  const schemas: Record<string, OpenapiSchema> = {
    Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    Pager: {
      type: 'object',
      additionalProperties: false,
      properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: maxPageSize, default: pageSize } },
    },
  };
  const owners = new Map<string, Node>();
  function reserve(name: string, node: Node): boolean {
    if (owners.get(name) === node) return false;
    if (schemas[name]) throw new Error(`OpenAPI schema name collision: ${name}`);
    owners.set(name, node);
    schemas[name] = {};
    return true;
  }
  function annotate(schema: OpenapiSchema, node: Node): OpenapiSchema {
    for (const key of ['description', 'example', 'default', 'readOnly', 'writeOnly'] as const) if (node[key] !== undefined) (schema as Record<string, unknown>)[key] = node[key];
    if (node.generated) schema.readOnly = true;
    return schema;
  }
  function baseField(node: Node): OpenapiSchema {
    return annotate(toOpenapi(valueSchema(node)), node);
  }
  function annotateInput(schema: OpenapiSchema, node: Node, defaults: boolean): OpenapiSchema {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const child = node.children[key];
      for (const attribute of ['description', 'example', 'writeOnly'] as const) if (child[attribute] !== undefined) (property as Record<string, unknown>)[attribute] = child[attribute];
      if (defaults && child.default !== undefined) property.default = child.default;
      if (!child.relation && child.base === 'object') annotateInput(child.many ? (property.items as OpenapiSchema) : property, child, defaults);
    }
    return schema;
  }
  function writeInput(node: Node, mode: 'create' | 'replace' | 'update', root = false, nestedMode = mode): OpenapiSchema {
    return annotateInput(toOpenapi(objectSchema(node, mode, root, (child) => relationInputSchema(child, nestedInput(child.relation as Entity, nestedMode)))), node, mode !== 'update');
  }
  function nestedInput(entity: Entity, mode: 'create' | 'replace' | 'update'): OpenapiSchema {
    const name = `${entity.name}Nested${mode[0].toUpperCase() + mode.slice(1)}`;
    if (!reserve(name, entity.root)) return ref(name);
    const existing = writeInput(entity.root, mode === 'replace' ? 'replace' : 'update', true, mode);
    existing.properties ??= {};
    existing.properties[entity.primary] = toOpenapi(valueSchema(entity.fields[entity.primary]));
    existing.required = [...(existing.required ?? []), entity.primary];
    const variants = [existing];
    if (entity.fields[entity.primary].generated) variants.push(writeInput(entity.root, 'create', true, mode));
    schemas[name] = { anyOf: variants, description: 'An object with a primary key updates an existing record; an object without a key creates one. PUT replaces, PATCH updates supplied fields.' };
    return ref(name);
  }
  function output(entity: Entity, node: Node): OpenapiSchema {
    if (node.relation) {
      entity = node.relation;
      node = entity.root;
    }
    const name = nodeName(entity, node);
    if (!reserve(name, node)) return ref(name);
    const properties: Record<string, OpenapiSchema> = {};
    for (const [key, child] of Object.entries(node.children)) {
      if (child.writeOnly) continue;
      if (child.relation || child.base === 'object') {
        const value = child.many ? page(entity, child) : output(entity, child);
        const shape = child.nullable || (child.relation && !child.many && !child.required) ? { anyOf: [value, { type: 'object' as const, nullable: true, enum: [null] }] } : value;
        const attributes = annotate({}, child);
        properties[key] = Object.keys(attributes).length ? { allOf: [shape], ...attributes } : shape;
      } else properties[key] = baseField(child);
    }
    // scope may select any subset, so response properties are intentionally optional.
    schemas[name] = { type: 'object', additionalProperties: false, properties };
    return ref(name);
  }
  function scope(entity: Entity, node: Node, list = node.many): OpenapiSchema {
    if (node.relation) {
      entity = node.relation;
      node = entity.root;
    }
    const name = `${nodeName(entity, node)}${list ? 'List' : ''}Scope`;
    if (!reserve(name, node)) return ref(name);
    const fieldsName = `${nodeName(entity, node)}ScopeFields`;
    if (reserve(fieldsName, node)) {
      const included: OpenapiSchema = { type: 'boolean', enum: [true] };
      const properties: Record<string, OpenapiSchema> = { '*': included };
      for (const [key, child] of Object.entries(node.children)) {
        if (child.writeOnly) continue;
        properties[key] = child.relation || child.base === 'object' ? scope(entity, child) : included;
      }
      schemas[fieldsName] = { type: 'object', additionalProperties: false, properties };
    }
    schemas[name] = {
      type: 'array',
      minItems: 1,
      maxItems: list ? 2 : 1,
      items: list ? { anyOf: [ref(fieldsName), options(entity, node)] } : ref(fieldsName),
      description: list
        ? '[fields, arguments?]. The first object selects fields; the optional second object contains where, order and pager. OpenAPI 3.0 cannot express positional item schemas; the server validates their order.'
        : '[fields]. * selects own fields without relations or writeOnly fields.',
    };
    return ref(name);
  }
  function page(entity: Entity, node: Node): OpenapiSchema {
    if (node.relation) {
      entity = node.relation;
      node = entity.root;
    }
    const name = `${nodeName(entity, node)}Page`;
    if (reserve(name, node))
      schemas[name] = { type: 'object', required: ['data', 'total'], properties: { data: { type: 'array', items: output(entity, node) }, total: { type: 'integer', minimum: 0 } } };
    return ref(name);
  }
  function where(entity: Entity, node: Node): OpenapiSchema {
    if (node.relation) {
      entity = node.relation;
      node = entity.root;
    }
    const name = `${nodeName(entity, node)}Where`;
    if (!reserve(name, node)) return ref(name);
    const properties: Record<string, OpenapiSchema> = { and: { type: 'array', items: ref(name) }, or: { type: 'array', minItems: 1, items: ref(name) }, not: ref(name) };
    for (const [key, child] of Object.entries(node.children))
      if (!child.writeOnly) {
        if (Object.hasOwn(properties, key)) throw new Error(`Reserved filter field: ${entity.name}.${child.path}`);
        properties[key] = !child.many && (child.relation || child.base === 'object') ? where(entity, child) : filter(entity, child);
      }
    schemas[name] = { type: 'object', additionalProperties: false, properties };
    return ref(name);
  }
  function filter(entity: Entity, node: Node): OpenapiSchema {
    const name = `${nodeName(entity, node)}Filter`;
    if (!reserve(name, node)) return ref(name);
    const properties: Record<string, OpenapiSchema> = {};
    const element = node.many ? (node.relation || node.base === 'object' ? where(entity, node) : filter(entity, { ...node, many: false, path: `${node.path}_element` })) : undefined;
    for (const [key, operand] of Object.entries(operatorsFor(node))) {
      const nullable = ['eq', 'ne', 'in'].includes(key);
      const scalar: OpenapiSchema = {
        type: node.base as 'string' | 'number' | 'boolean',
        ...(nullable ? { nullable: true } : {}),
        ...(node.enum ? { enum: [...node.enum, ...(nullable && !node.enum.includes(null) ? [null] : [])] } : {}),
      };
      if (operand === 'condition') properties[key] = ref(name);
      else if (operand === 'element') properties[key] = element!;
      else
        properties[key] =
          operand === 'values' ? { type: 'array', items: scalar } : operand === 'text' ? { type: 'string' } : operand === 'comparison' ? { type: node.base as 'string' | 'number' } : scalar;
    }
    schemas[name] = { type: 'object', additionalProperties: false, properties };
    return ref(name);
  }
  function order(entity: Entity, node: Node): OpenapiSchema {
    if (node.relation) {
      entity = node.relation;
      node = entity.root;
    }
    const name = `${nodeName(entity, node)}Order`;
    if (reserve(name, node)) {
      const paths = sortableFields(node);
      schemas[name] = {
        type: 'array',
        ...(paths.length
          ? {
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['field', 'direction'],
                properties: { field: { type: 'string', enum: paths }, direction: { type: 'string', enum: ['ASC', 'DESC'] } },
              },
            }
          : { maxItems: 0, items: { type: 'object' } }),
      };
    }
    return ref(name);
  }
  function options(entity: Entity, node: Node): OpenapiSchema {
    return { type: 'object', additionalProperties: false, properties: { where: where(entity, node), order: order(entity, node), pager: ref('Pager') } };
  }
  const paths: OpenapiDocument['paths'] = {};
  const operations = new Set<string>();
  for (const entity of model.entities.filter((e) => e.api.includes('openapi'))) {
    const name = entity.name;
    const op = operationName(entity);
    for (const mode of ['create', 'replace', 'update'] as const) {
      const key = `${name}${mode[0].toUpperCase() + mode.slice(1)}`;
      reserve(key, entity.root);
      schemas[key] = writeInput(entity.root, mode, true);
    }
    const selectionParameter = (list: boolean) => ({
      in: 'query',
      name: 'scope',
      ...json(scope(entity, entity.root, list)),
      description:
        'JSON [fields, arguments?]. Scalars use true; objects and relations use their own scope arrays. * includes own fields without relations or writeOnly fields. Arguments are available only on lists.',
    });
    const shape = [selectionParameter(false)];
    const list = [selectionParameter(true)];
    const key = { in: 'path', name: entity.primary, required: true, schema: baseField({ ...entity.fields[entity.primary], generated: undefined }) };
    const errors = { 400: response('Invalid request', ref('Error')), 404: response('Not found', ref('Error')), 409: response('Conflict', ref('Error')) };
    const make = (operationId: string, parameters: unknown[], schema: unknown, mode?: 'create' | 'replace' | 'update') => {
      if (operations.has(operationId)) throw new Error(`OpenAPI operation collision: ${operationId}`);
      operations.add(operationId);
      return {
        operationId,
        tags: [entity.collection],
        parameters,
        ...(mode ? { requestBody: { required: true, ...json(ref(`${name}${mode[0].toUpperCase() + mode.slice(1)}`)) } } : {}),
        responses: { [mode === 'create' ? 201 : 200]: response('Success', schema), ...errors },
      };
    };
    paths[`/${entity.collection}`] = { get: make(`${op}List`, list, page(entity, entity.root)), post: make(`${op}Create`, shape, output(entity, entity.root), 'create') };
    paths[`/${entity.collection}/{${entity.primary}}`] = {
      get: make(op, [key, ...shape], output(entity, entity.root)),
      put: make(`${op}Replace`, [key, ...shape], output(entity, entity.root), 'replace'),
      patch: make(`${op}Update`, [key, ...shape], output(entity, entity.root), 'update'),
      delete: make(`${op}Delete`, [key, ...shape], output(entity, entity.root)),
    };
  }
  const parameters: Record<string, unknown> = {};
  if (files) {
    for (const [name, schema] of Object.entries({ FileMetadata: FILE_METADATA_SCHEMA, FileUpdate: FILE_UPDATE_SCHEMA })) {
      if (schemas[name]) throw new Error(`OpenAPI schema collision: ${name}`);
      schemas[name] = schema;
    }
    Object.assign(parameters, {
      FilePath: { in: 'path', name: 'path', required: true, schema: { type: 'string' } },
      ContentDirectory: { in: 'header', name: FILE_HEADERS.directory.name, schema: { type: 'string' } },
      ContentName: { in: 'header', name: FILE_HEADERS.name.name, required: true, schema: { type: 'string' } },
      ContentOverride: { in: 'header', name: FILE_HEADERS.override.name, schema: { type: 'string', enum: ['false', 'true'], default: 'false' } },
    });
    for (const [path, item] of Object.entries(createFilePaths())) {
      if (paths[path]) throw new Error(`File path collision: ${path}`);
      for (const operation of Object.values(item)) {
        if (isObject(operation) && typeof operation.operationId === 'string') {
          if (operations.has(operation.operationId)) throw new Error(`OpenAPI operation collision: ${operation.operationId}`);
          operations.add(operation.operationId);
        }
      }
      paths[path] = item;
    }
  }
  if (auth) {
    for (const [name, schema] of Object.entries(AUTH_SCHEMAS)) {
      if (schemas[name]) throw new Error(`OpenAPI schema collision: ${name}`);
      schemas[name] = structuredClone(schema);
    }
    for (const [path, item] of Object.entries(authOpenapiPaths())) {
      if (paths[path] || model.entities.some((entity) => path.startsWith(`/${entity.collection}/`))) throw new Error(`Auth path collision: ${path}`);
      for (const operation of Object.values(item)) {
        const id = (operation as { operationId: string }).operationId;
        if (operations.has(id)) throw new Error(`OpenAPI operation collision: ${id}`);
        operations.add(id);
      }
      paths[path] = item;
    }
  }
  return { openapi: '3.0.3', info, components: { schemas, parameters, ...(auth ? { securitySchemes: structuredClone(AUTH_SECURITY_SCHEMES) } : {}) }, paths };
}
