import { VERSION } from '../core/constants.js';
import {
  assertApi,
  canonicalNode,
  type Entity,
  fieldAt,
  type Model,
  type Node,
  nodeName,
  objectSchema,
  operationName,
  relationInputSchema,
  type ValidationSchema,
  valueSchema,
} from '../core/model.js';
import { MUTATIONS, type Mutation, type WriteMode } from '../core/operations.js';
import { normalizePagination } from '../core/pagination.js';
import { operatorsFor } from '../core/query/contract.js';
import { sortableFields } from '../core/query/options.js';
import { capitalize, defined, isObject } from '../core/utils.js';
import { FILE_HEADERS, FILE_METADATA_SCHEMA, FILE_UPDATE_SCHEMA } from '../files/http.js';
import { AUTH_SCHEMAS, AUTH_SECURITY_SCHEMES, authOpenapiPaths } from './auth.js';
import { createFilePaths } from './files.js';
import { json, ref, response } from './helpers.js';
import type { OpenapiInfo } from './options.js';
import { OpenapiRegistry } from './registry.js';
import type { OpenapiDocument, OpenapiMethod, OpenapiOperation, OpenapiParameter, OpenapiSchema } from './types.js';

/** Преобразует nullable-значения JSON Schema в представление OpenAPI 3.0, рекурсивно обрабатывая поля и элементы.
 * @example { anyOf: [{ type: 'string' }, { type: 'null' }] } → { type: 'string', nullable: true }.
 */
function toOpenapi(schema: ValidationSchema): OpenapiSchema {
  const { type, properties, items, additionalProperties, allOf, anyOf, oneOf, not, ...attributes } = schema;
  const result: OpenapiSchema = { ...attributes };
  if (Array.isArray(type)) return toOpenapi({ ...schema, type: undefined, allOf: [...(allOf ?? []), { anyOf: type.map((value) => ({ type: value })) }] });
  if (type === 'null') return { type: 'object', nullable: true, enum: [null] };
  if (type) result.type = type;
  if (properties) result.properties = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, toOpenapi(value)]));
  if (items) result.items = toOpenapi(items);
  if (additionalProperties !== undefined) result.additionalProperties = typeof additionalProperties === 'boolean' ? additionalProperties : toOpenapi(additionalProperties);
  if (allOf) result.allOf = allOf.map(toOpenapi);
  if (oneOf) result.oneOf = oneOf.map(toOpenapi);
  if (not) result.not = toOpenapi(not);
  if (anyOf) {
    const nonNull = anyOf.filter((value) => value.type !== 'null');
    const single = nonNull[0];
    if (anyOf.length === 2 && nonNull.length === 1 && single) {
      const converted = toOpenapi(single);
      if (converted.type) return { ...converted, ...result, nullable: true, ...(converted.enum ? { enum: [...converted.enum.filter((value) => value !== null), null] } : {}) };
    }
    result.anyOf = anyOf.map(toOpenapi);
  }
  return result;
}
/** Строит документ с маршрутами и схемами записей, включая выбранные дополнительные маршруты.
 * @example { model, files: true } → документ с paths['/_files/storage'].
 */
export function buildOpenapiDocument({
  model,
  database = true,
  files = false,
  auth = false,
  pageSize,
  maxPageSize,
  info = { title: 'Deep JSON Server API', version: VERSION },
}: {
  model: Model | undefined;
  database?: boolean;
  files?: boolean;
  auth?: boolean;
  pageSize?: number;
  maxPageSize?: number;
  info?: OpenapiInfo;
}): OpenapiDocument {
  if (database) assertApi(model, 'openapi');
  ({ pageSize, maxPageSize } = normalizePagination({ pageSize, maxPageSize }));
  const registry = new OpenapiRegistry({
    Error: { type: 'object', properties: { error: { type: 'string' } }, required: ['error'] },
    Pager: {
      type: 'object',
      additionalProperties: false,
      properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: maxPageSize, default: pageSize } },
    },
  });
  const { schemas } = registry;
  const reserve = (name: string, node: Node): boolean => registry.reserve(name, node);
  function annotate(schema: OpenapiSchema, node: Node): OpenapiSchema {
    for (const key of ['description', 'example', 'default', 'readOnly', 'writeOnly'] as const) if (node[key] !== undefined) Object.assign(schema, { [key]: node[key] });
    if (node.generated) schema.readOnly = true;
    return schema;
  }
  function baseField(node: Node): OpenapiSchema {
    return annotate(toOpenapi(valueSchema(node)), node);
  }
  function annotateInput(schema: OpenapiSchema, node: Node, defaults: boolean): OpenapiSchema {
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      const child = defined(node.children[key], key);
      for (const attribute of ['description', 'example', 'writeOnly'] as const) if (child[attribute] !== undefined) Object.assign(property, { [attribute]: child[attribute] });
      if (defaults && child.default !== undefined) property.default = child.default;
      if (!child.relation && child.base === 'object') annotateInput(child.many ? (property.items as OpenapiSchema) : property, child, defaults);
    }
    return schema;
  }
  function writeInput(node: Node, mode: WriteMode, root = false, nestedMode = mode): OpenapiSchema {
    return annotateInput(toOpenapi(objectSchema(node, mode, root, (child) => relationInputSchema(child, nestedInput(child.relation as Entity, nestedMode)))), node, mode !== 'update');
  }
  function nestedInput(entity: Entity, mode: WriteMode): OpenapiSchema {
    const name = `${entity.name}Nested${capitalize(mode)}`;
    if (!reserve(name, entity.root)) return ref(name);
    const existing = writeInput(entity.root, mode === 'replace' ? 'replace' : 'update', true, mode);
    existing.properties ??= {};
    existing.properties[entity.primary] = toOpenapi(valueSchema(fieldAt(entity, entity.primary)));
    existing.required = [...(existing.required ?? []), entity.primary];
    const variants = [existing];
    if (fieldAt(entity, entity.primary).generated) variants.push(writeInput(entity.root, 'create', true, mode));
    schemas[name] = { anyOf: variants, description: 'An object with a primary key updates an existing record; an object without a key creates one. PUT replaces, PATCH updates supplied fields.' };
    return ref(name);
  }
  function output(entity: Entity, node: Node): OpenapiSchema {
    [entity, node] = canonicalNode(entity, node);
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
    // Выбор может содержать любую часть полей, поэтому поля ответа необязательны.
    schemas[name] = { type: 'object', additionalProperties: false, properties };
    return ref(name);
  }
  function scope(entity: Entity, node: Node, list = node.many): OpenapiSchema {
    [entity, node] = canonicalNode(entity, node);
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
    const tuple: OpenapiSchema = {
      type: 'array',
      minItems: 1,
      maxItems: list ? 2 : 1,
      items: list ? { anyOf: [ref(fieldsName), options(entity, node)] } : ref(fieldsName),
      description: list
        ? '[fields, arguments?]. The first object selects fields; the optional second object contains where, order and pager. OpenAPI 3.0 cannot express positional item schemas; the server validates their order.'
        : '[fields]. * selects scalar fields except relation keys; arrays, objects, relations and relation keys require explicit selection. writeOnly fields cannot be selected.',
    };
    schemas[name] = list
      ? {
          anyOf: [
            tuple,
            {
              type: 'object',
              additionalProperties: false,
              required: ['union'],
              properties: { union: { type: 'array', minItems: 1, items: ref(name) } },
              description:
                'Combines list scopes in array order. Entity records are deduplicated by primary key; embedded objects are deduplicated by source element, preserving distinct elements with equal contents.',
            },
          ],
        }
      : tuple;
    return ref(name);
  }
  function page(entity: Entity, node: Node): OpenapiSchema {
    [entity, node] = canonicalNode(entity, node);
    const name = `${nodeName(entity, node)}Page`;
    if (reserve(name, node))
      schemas[name] = { type: 'object', required: ['data', 'total'], properties: { data: { type: 'array', items: output(entity, node) }, total: { type: 'integer', minimum: 0 } } };
    return ref(name);
  }
  function where(entity: Entity, node: Node): OpenapiSchema {
    [entity, node] = canonicalNode(entity, node);
    const name = `${nodeName(entity, node)}Where`;
    if (!reserve(name, node)) return ref(name);
    const properties: Record<string, OpenapiSchema> = { and: { type: 'array', items: ref(name) }, or: { type: 'array', minItems: 1, items: ref(name) }, not: ref(name) };
    for (const [key, child] of Object.entries(node.children))
      if (!child.writeOnly && !child.virtual) {
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
      else if (operand === 'element') {
        if (!element) throw new Error(`Missing element filter for ${node.path}`);
        properties[key] = element;
      } else
        properties[key] =
          operand === 'values' ? { type: 'array', items: scalar } : operand === 'text' ? { type: 'string' } : operand === 'comparison' ? { type: node.base as 'string' | 'number' } : scalar;
    }
    schemas[name] = { type: 'object', additionalProperties: false, properties };
    return ref(name);
  }
  function order(entity: Entity, node: Node): OpenapiSchema {
    [entity, node] = canonicalNode(entity, node);
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
  for (const entity of database ? (model?.entities ?? []).filter((e) => e.api.includes('rest')) : []) {
    const name = entity.name;
    const op = operationName(entity);
    for (const { mode, hasBody } of MUTATIONS) {
      if (!hasBody) continue;
      const key = `${name}${capitalize(mode)}`;
      reserve(key, entity.root);
      schemas[key] = writeInput(entity.root, mode, true);
    }
    const selectionParameter = (list: boolean): OpenapiParameter => ({
      in: 'query',
      name: 'scope',
      ...json(scope(entity, entity.root, list)),
      description:
        'JSON [fields, arguments?] or, for lists, { union: [scope, ...] }. Scalars and primitive arrays use true; objects and relations use their own scope arrays. * includes scalar fields except relation keys. Arguments are available only on lists.',
    });
    const shape = [selectionParameter(false)];
    const list = [selectionParameter(true)];
    const key: OpenapiParameter = { in: 'path', name: entity.primary, required: true, schema: baseField({ ...fieldAt(entity, entity.primary), generated: undefined }) };
    const errors = { 400: response('Invalid request', ref('Error')), 404: response('Not found', ref('Error')), 409: response('Conflict', ref('Error')) };
    const make = (operationId: string, parameters: OpenapiParameter[], schema: OpenapiSchema, mutation?: Mutation): OpenapiOperation => {
      if (operations.has(operationId)) throw new Error(`OpenAPI operation collision: ${operationId}`);
      operations.add(operationId);
      return {
        operationId,
        tags: [entity.collection],
        parameters,
        ...(auth ? { security: mutation ? [{ AuthBearer: [] }] : [{}, { AuthBearer: [] }] } : {}),
        ...(mutation?.hasBody ? { requestBody: { required: true, ...json(ref(`${name}${capitalize(mutation.mode)}`)) } } : {}),
        responses: {
          [mutation?.status ?? 200]: response('Success', schema),
          ...errors,
          ...(auth ? { 401: response(mutation ? 'Authentication required' : 'Invalid or expired credentials', ref('Error')) } : {}),
          ...(auth && mutation ? { 403: response('Forbidden', ref('Error')) } : {}),
        },
      };
    };
    const collectionPath = `/${entity.collection}`;
    const itemPath = `${collectionPath}/{${entity.primary}}`;
    paths[collectionPath] = { get: make(`${op}List`, list, page(entity, entity.root)) };
    paths[itemPath] = { get: make(op, [key, ...shape], output(entity, entity.root)) };
    for (const mutation of MUTATIONS) {
      defined(paths[mutation.hasKey ? itemPath : collectionPath], 'operation path')[mutation.method.toLowerCase() as OpenapiMethod] = make(
        `${op}${capitalize(mutation.mode)}`,
        mutation.hasKey ? [key, ...shape] : shape,
        output(entity, entity.root),
        mutation,
      );
    }
  }
  const parameters: OpenapiDocument['components']['parameters'] = {};
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
      if (paths[path] || (database && model?.entities.some((entity) => path.startsWith(`/${entity.collection}/`)))) throw new Error(`Auth path collision: ${path}`);
      for (const operation of Object.values(item)) {
        const id = operation.operationId;
        if (operations.has(id)) throw new Error(`OpenAPI operation collision: ${id}`);
        operations.add(id);
      }
      paths[path] = item;
    }
  }
  return { openapi: '3.0.3', info, components: { schemas, parameters, ...(auth ? { securitySchemes: structuredClone(AUTH_SECURITY_SCHEMES) } : {}) }, paths };
}
