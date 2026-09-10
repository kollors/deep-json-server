import { readFile } from 'node:fs/promises';
import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { getRelationMetadata } from './relation-metadata.js';
import type { DatabaseData, JsonValue } from './types.js';
import { assertKnownKeys, createHttpError, isObject, isSafeKey, singularize, toPascalCase } from './utils.js';

export interface Field {
  type: string;
  description?: string;
  example?: JsonValue;
  required?: boolean;
  nullable?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  primary?: boolean;
  generated?: 'uuid' | 'increment';
  readOnly?: boolean;
  writeOnly?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: 'date' | 'date-time' | 'email' | 'uri' | 'uuid';
  minimum?: number;
  maximum?: number;
  source?: string;
  target?: string;
  onDelete?: 'restrict' | 'cascade';
}
export interface EntityDefinition {
  collection: string;
  api?: ('openapi' | 'graphql')[];
  fields: Record<string, Field>;
}
export type ModelSchema = Record<string, EntityDefinition>;
export interface Node extends Field {
  path: string;
  base: string;
  many: boolean;
  children: Record<string, Node>;
  relation?: Entity;
  implicit?: boolean;
}
export interface Entity {
  name: string;
  collection: string;
  api: ('openapi' | 'graphql')[];
  primary: string;
  fields: Record<string, Node>;
  root: Node;
}
export interface Model {
  entities: Entity[];
  byName: Map<string, Entity>;
  byCollection: Map<string, Entity>;
  explicit: boolean;
}
export type ValidationSchema = Record<string, unknown>;
export const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, ownProperties: true });
addFormats.default(ajv);
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'object']);
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_KEYS = new Set([
  'type',
  'description',
  'example',
  'required',
  'nullable',
  'default',
  'enum',
  'primary',
  'generated',
  'readOnly',
  'writeOnly',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minimum',
  'maximum',
  'source',
  'target',
  'onDelete',
]);
export const pathParts = (path: string): string[] => {
  const parts = path.split('.');
  if (parts.some((p) => !NAME.test(p) || !isSafeKey(p))) throw createHttpError(400, `Invalid field path: ${path}`);
  return parts;
};
export const readPath = (value: unknown, path: string | string[]): unknown[] => {
  const parts = typeof path === 'string' ? pathParts(path) : path;
  if (!parts.length) return Array.isArray(value) ? value.flatMap((v) => readPath(v, [])) : value == null ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => readPath(v, parts));
  return isObject(value) && Object.hasOwn(value, parts[0]) ? readPath(value[parts[0]], parts.slice(1)) : [];
};
export const childName = (node: Node): string => node.path.split('.').at(-1) as string;
export const nodeName = (entity: Entity, node: Node): string => (node.path ? `${entity.name}_${node.path.replaceAll('.', '_')}` : entity.name);
export const operationName = (entity: Entity): string => entity.name[0].toLowerCase() + entity.name.slice(1);
const newNode = (path: string, field: Field): Node => ({ ...field, path, base: field.type.replace(/\[\]$/, ''), many: field.type.endsWith('[]'), children: Object.create(null) });
function addField(entity: Entity, path: string, field: Field, implicit = false): Node {
  const parts = pathParts(path);
  let parent = entity.root;
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('.');
    if (!parent.children[parts[i]]) {
      parent.children[parts[i]] = newNode(prefix, { type: 'object' });
      entity.fields[prefix] = parent.children[parts[i]];
    }
    parent = parent.children[parts[i]];
    if (parent.base !== 'object') throw new Error(`Field ${entity.name}.${prefix} cannot contain fields`);
  }
  const key = parts.at(-1) as string;
  const node = newNode(path, field);
  node.implicit = implicit;
  node.children = parent.children[key]?.children ?? {};
  parent.children[key] = node;
  entity.fields[path] = node;
  return node;
}
function checkField(path: string, field: unknown): asserts field is Field {
  if (!isObject(field)) throw new Error(`Field ${path} must be an object`);
  assertKnownKeys(field, FIELD_KEYS, path);
  if (typeof field.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*(\[\])?$/.test(field.type)) throw new Error(`Invalid type at ${path}`);
  for (const key of ['required', 'nullable', 'primary', 'readOnly', 'writeOnly']) if (field[key] !== undefined && typeof field[key] !== 'boolean') throw new Error(`${path}.${key} must be boolean`);
  for (const key of ['description', 'pattern', 'source', 'target']) if (field[key] !== undefined && typeof field[key] !== 'string') throw new Error(`${path}.${key} must be string`);
  for (const key of ['minLength', 'maxLength', 'minimum', 'maximum'])
    if (field[key] !== undefined && (typeof field[key] !== 'number' || !Number.isFinite(field[key]))) throw new Error(`${path}.${key} must be finite`);
  for (const key of ['minLength', 'maxLength'])
    if (field[key] !== undefined && (!Number.isSafeInteger(field[key]) || (field[key] as number) < 0)) throw new Error(`${path}.${key} must be nonnegative integer`);
  if (field.readOnly && field.writeOnly) throw new Error(`${path}: readOnly and writeOnly conflict`);
  if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length)) throw new Error(`${path}: enum must be nonempty array`);
  if (field.generated !== undefined && !['uuid', 'increment'].includes(String(field.generated))) throw new Error(`${path}: invalid generated`);
  if (field.generated && (field.default !== undefined || field.writeOnly || field.nullable)) throw new Error(`${path}: generated conflicts with default, writeOnly or nullable`);
  if (field.generated && field.type !== (field.generated === 'uuid' ? 'string' : 'number')) throw new Error(`${path}: generated type mismatch`);
  if (field.primary && (field.nullable || field.required === false || field.writeOnly || !['string', 'number'].includes(field.type as string) || path.includes('.')))
    throw new Error(`${path}: invalid primary key`);
  if (field.onDelete !== undefined && !['restrict', 'cascade'].includes(String(field.onDelete))) throw new Error(`${path}: invalid onDelete`);
  if (field.format !== undefined && !['date', 'date-time', 'email', 'uri', 'uuid'].includes(String(field.format))) throw new Error(`${path}: unknown format`);
  const base = (field.type as string).replace(/\[\]$/, '');
  if (['minLength', 'maxLength', 'pattern', 'format'].some((k) => field[k] !== undefined) && base !== 'string') throw new Error(`${path}: string constraint on non-string field`);
  if (['minimum', 'maximum'].some((k) => field[k] !== undefined) && base !== 'number') throw new Error(`${path}: number constraint on non-number field`);
  if (typeof field.pattern === 'string') new RegExp(field.pattern, 'u');
  if (typeof field.minimum === 'number' && typeof field.maximum === 'number' && field.minimum > field.maximum) throw new Error(`${path}: minimum exceeds maximum`);
  if (typeof field.minLength === 'number' && typeof field.maxLength === 'number' && field.minLength > field.maxLength) throw new Error(`${path}: minLength exceeds maxLength`);
}
export async function loadModel(source: unknown): Promise<Model | undefined> {
  if (source === undefined) return undefined;
  const schema: unknown = typeof source === 'string' ? JSON.parse(await readFile(source, 'utf8')) : source;
  if (!isObject(schema) || !Object.keys(schema).length) throw new Error('Model schema must be a nonempty object');
  if ('$schema' in schema || '$info' in schema) throw new Error('Legacy $schema/$info format is no longer supported');
  const model: Model = { entities: [], byName: new Map(), byCollection: new Map(), explicit: true };
  for (const [name, definition] of Object.entries(schema)) {
    if (!NAME.test(name) || !isSafeKey(name) || PRIMITIVES.has(name) || !isObject(definition)) throw new Error(`Invalid model ${name}`);
    assertKnownKeys(definition, new Set(['collection', 'api', 'fields']), name);
    if (typeof definition.collection !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(definition.collection) || !isSafeKey(definition.collection)) throw new Error(`Invalid collection for ${name}`);
    if (model.byCollection.has(definition.collection)) throw new Error(`Duplicate collection ${definition.collection}`);
    const api = definition.api ?? ['openapi', 'graphql'];
    if (!Array.isArray(api) || api.some((v) => !['openapi', 'graphql'].includes(v)) || new Set(api).size !== api.length) throw new Error(`Invalid api for ${name}`);
    if (!isObject(definition.fields)) throw new Error(`${name}.fields must be an object`);
    const entity: Entity = { name, collection: definition.collection, api, primary: '', fields: Object.create(null), root: newNode('', { type: 'object' }) };
    for (const [path, field] of Object.entries(definition.fields).sort(([a], [b]) => a.split('.').length - b.split('.').length)) {
      checkField(path, field);
      addField(entity, path, field);
      if (field.primary) {
        if (entity.primary) throw new Error(`${name}: only one primary key is supported`);
        entity.primary = path;
        entity.fields[path].required = true;
      }
    }
    if (!entity.primary) throw new Error(`${name}: primary key is required`);
    model.entities.push(entity);
    model.byName.set(name, entity);
    model.byCollection.set(entity.collection, entity);
  }
  for (const entity of model.entities)
    for (const node of Object.values(entity.fields)) {
      if (PRIMITIVES.has(node.base)) {
        if (node.source !== undefined || node.target !== undefined || node.onDelete !== undefined) throw new Error(`${entity.name}.${node.path}: relation metadata on primitive`);
        continue;
      }
      const target = model.byName.get(node.base);
      if (!target) throw new Error(`Unknown model ${node.base}`);
      if (node.generated || node.default !== undefined || node.enum || node.primary || node.readOnly || node.writeOnly) throw new Error(`${entity.name}.${node.path}: invalid relation options`);
      node.relation = target;
      node.source ??= entity.primary;
      node.target ??= target.primary;
      pathParts(node.source);
      pathParts(node.target);
    }
  // Resolve omitted storage key declarations without depending on database samples.
  let pending = model.entities.flatMap((entity) =>
    Object.values(entity.fields)
      .filter((n) => n.relation)
      .map((node) => ({ entity, node })),
  );
  while (pending.length) {
    let progress = false;
    pending = pending.filter(({ entity, node }) => {
      const target = node.relation as Entity;
      const targetField = target.fields[node.target as string];
      const sourceField = entity.fields[node.source as string];
      if (sourceField && targetField) return false;
      if (!sourceField && targetField && ['string', 'number'].includes(targetField.base) && !targetField.relation) {
        addField(entity, node.source as string, { type: targetField.base + (node.many && node.target === target.primary ? '[]' : ''), ...(node.nullable ? { nullable: true } : {}) }, true);
        progress = true;
        return false;
      }
      return true;
    });
    if (pending.length && !progress) throw new Error(`Declare ambiguous relation keys: ${pending.map(({ entity, node }) => `${entity.name}.${node.path}`).join(', ')}`);
  }
  for (const entity of model.entities)
    for (const node of Object.values(entity.fields)) {
      if (node.generated && node.path.includes('.')) throw new Error(`Generated fields must be root fields: ${entity.name}.${node.path}`);
      if (node.relation) {
        const sourceField = entity.fields[node.source as string];
        const targetField = node.relation.fields[node.target as string];
        if (sourceField.relation || targetField.relation || !['string', 'number'].includes(sourceField.base) || sourceField.base !== targetField.base)
          throw new Error(`Incompatible relation keys: ${entity.name}.${node.path}`);
      } else {
        const validate = ajv.compile(valueSchema(node));
        for (const key of ['default', 'example'] as const) if (node[key] !== undefined && !validate(structuredClone(node[key]))) throw new Error(`Invalid ${key}: ${entity.name}.${node.path}`);
      }
    }
  return model;
}
export function assertApi(model: Model | undefined, api: 'graphql' | 'openapi'): asserts model is Model {
  if (!model?.explicit) throw new Error(`${api} requires an explicit model schema`);
  for (const entity of model.entities.filter((e) => e.api.includes(api)))
    for (const node of Object.values(entity.fields))
      if (node.relation && !node.relation.api.includes(api)) throw new Error(`${entity.name}.${node.path}: ${node.relation.name} does not enable ${api}`);
}
export function valueSchema(node: Node): ValidationSchema {
  let schema: ValidationSchema = node.base === 'object' ? objectSchema(node, 'stored') : { type: node.base };
  for (const key of ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'enum']) if (node[key as keyof Node] !== undefined) schema[key] = node[key as keyof Node];
  if (node.many) schema = { type: 'array', items: schema };
  if (node.nullable) schema = { anyOf: [schema, { type: 'null' }] };
  return schema;
}
export type InputMode = 'stored' | 'create' | 'replace' | 'update';
export function objectSchema(node: Node, mode: InputMode, root = false): ValidationSchema {
  const properties: Record<string, ValidationSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(node.children)) {
    if (child.relation || (mode !== 'stored' && (child.generated || child.readOnly || (child.primary && mode !== 'create')))) continue;
    properties[key] =
      child.base === 'object'
        ? (() => {
            let s: ValidationSchema = objectSchema(child, mode);
            if (child.many) s = { type: 'array', items: s };
            return child.nullable ? { anyOf: [s, { type: 'null' }] } : s;
          })()
        : valueSchema(child);
    if (child.required && !(root && mode === 'update') && !(mode !== 'stored' && child.default !== undefined)) required.push(key);
  }
  return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}
export const validators = new WeakMap<Entity, Map<InputMode, ValidateFunction>>();
export function validateRecord(entity: Entity, value: unknown, mode: InputMode): void {
  let cache = validators.get(entity);
  if (!cache) {
    cache = new Map();
    validators.set(entity, cache);
  }
  let validate = cache.get(mode);
  if (!validate) {
    validate = ajv.compile(objectSchema(entity.root, mode, true));
    cache.set(mode, validate);
  }
  if (!validate(value)) throw createHttpError(400, `${entity.name}: ${ajv.errorsText(validate.errors)}`);
}
export function inferModel(database: DatabaseData): Model {
  const model: Model = { entities: [], byName: new Map(), byCollection: new Map(), explicit: false };
  for (const [collection, records] of Object.entries(database)) {
    const name = toPascalCase(singularize(collection));
    const entity: Entity = { name, collection, api: [], primary: 'id', fields: Object.create(null), root: newNode('', { type: 'object' }) };
    const scan = (record: Record<string, unknown>, prefix = '') => {
      for (const [key, value] of Object.entries(record)) {
        const path = prefix + key;
        const sample = Array.isArray(value) ? value.find((v) => v !== null) : value;
        const base = isObject(sample) ? 'object' : ['string', 'number', 'boolean'].includes(typeof sample) ? typeof sample : 'string';
        if (!entity.fields[path] || sample != null) addField(entity, path, { type: base + (Array.isArray(value) ? '[]' : '') });
        if (isObject(value)) scan(value, `${path}.`);
        if (Array.isArray(value))
          value.filter(isObject).forEach((v) => {
            scan(v, `${path}.`);
          });
      }
    };
    records.forEach((scanRecord) => {
      scan(scanRecord);
    });
    if (!entity.fields.id) addField(entity, 'id', { type: 'string' });
    entity.fields.id.primary = true;
    model.entities.push(entity);
    model.byCollection.set(collection, entity);
    model.byName.set(name, entity);
  }
  const resources = Object.keys(database);
  for (const entity of model.entities)
    for (const field of Object.values(entity.fields)) {
      const relation = getRelationMetadata(childName(field), resources, entity.collection);
      if (!relation) continue;
      const target = model.byCollection.get(relation.targetResource) as Entity;
      const prefix = field.path.includes('.') ? field.path.slice(0, field.path.lastIndexOf('.') + 1) : '';
      const path = prefix + relation.relationName;
      if (!entity.fields[path]) {
        const node = addField(entity, path, { type: target.name + (relation.isMany ? '[]' : ''), source: field.path, target: 'id' });
        node.relation = target;
      }
      if (!target.fields[relation.reverseRelationName]) {
        const reverse = addField(target, relation.reverseRelationName, { type: `${entity.name}[]`, source: 'id', target: field.path });
        reverse.relation = entity;
      }
    }
  return model;
}
