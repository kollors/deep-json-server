import { readFile } from 'node:fs/promises';
import { recordOptions } from '../lifecycle/options.js';
import { assertKnownKeys, isObject, isSafeKey } from '../utils.js';
import { addField, fieldAt, linkRelation, markRelationKeys, NAME, newNode, pathParts, systemFields } from './tree.js';
import type { ApiFormat, Entity, Field, Model, ModelOptions, Node, RelationNode } from './types.js';
import { createValidator, entityValidators, valueSchema } from './validation.js';
/** Проверяет список форматов и возвращает его независимую копию.
 * @example apiFormats(['graphql'], [], 'api') → ['graphql']; apiFormats(['unknown'], [], 'api') → ошибка.
 */
export function apiFormats(value: unknown, fallback: ApiFormat[], label: string): ApiFormat[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.some((format) => !['openapi', 'graphql'].includes(format)) || new Set(value).size !== value.length) throw new Error(`Invalid api for ${label}`);
  return [...value] as ApiFormat[];
}
const PRIMITIVES = new Set(['string', 'number', 'boolean', 'object']);
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
/** Проверяет свойства описания поля и совместимость ограничений с его типом.
 * @example { type: 'string', minLength: 1 } → допустимо; { type: 'number', minLength: 1 } → ошибка.
 */
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
  if (field.primary && (field.nullable || field.required === false || field.writeOnly || !['string', 'number'].includes(field.type) || path.includes('.')))
    throw new Error(`${path}: invalid primary key`);
  if (field.onDelete !== undefined && !['restrict', 'cascade'].includes(String(field.onDelete))) throw new Error(`${path}: invalid onDelete`);
  if (field.format !== undefined && !['date', 'date-time', 'email', 'uri', 'uuid'].includes(String(field.format))) throw new Error(`${path}: unknown format`);
  const base = field.type.replace(/\[\]$/, '');
  if (base === 'object' && field.enum !== undefined) throw new Error(`${path}: enum is supported only for primitive fields`);
  if (['minLength', 'maxLength', 'pattern', 'format'].some((k) => field[k] !== undefined) && base !== 'string') throw new Error(`${path}: string constraint on non-string field`);
  if (['minimum', 'maximum'].some((k) => field[k] !== undefined) && base !== 'number') throw new Error(`${path}: number constraint on non-number field`);
  if (typeof field.pattern === 'string') new RegExp(field.pattern, 'u');
  if (typeof field.minimum === 'number' && typeof field.maximum === 'number' && field.minimum > field.maximum) throw new Error(`${path}: minimum exceeds maximum`);
  if (typeof field.minLength === 'number' && typeof field.maxLength === 'number' && field.minLength > field.maxLength) throw new Error(`${path}: minLength exceeds maxLength`);
}
/** Загружает описание из объекта или JSON-файла, проверяет поля и сопоставляет связи.
 * @example loadModel(undefined) → Promise<undefined>; корректное описание → Promise<Model>.
 */
export async function loadModel(source: unknown, settings: ModelOptions = {}): Promise<Model | undefined> {
  if (source === undefined) return undefined;
  const schema: unknown = typeof source === 'string' ? JSON.parse(await readFile(source, 'utf8')) : structuredClone(source);
  const ajv = createValidator();
  if (!isObject(schema) || !Object.keys(schema).length) throw new Error('Model schema must be a nonempty object');
  assertKnownKeys(schema, new Set(['models', 'api', 'timestamps', 'softDelete']), 'schema');
  if (!isObject(schema.models) || !Object.keys(schema.models).length) throw new Error('schema.models must be a nonempty object');
  const options = recordOptions({ auth: settings.auth, timestamps: schema.timestamps as boolean | undefined, softDelete: schema.softDelete as boolean | undefined });
  const defaults = apiFormats(schema.api, apiFormats(settings.api, ['openapi', 'graphql'], 'defaults'), 'schema');
  const model: Model = { entities: [], byName: new Map(), byCollection: new Map(), explicit: true, options };
  for (const [name, definition] of Object.entries(schema.models)) {
    if (!NAME.test(name) || !isSafeKey(name) || PRIMITIVES.has(name) || !isObject(definition)) throw new Error(`Invalid model ${name}`);
    assertKnownKeys(definition, new Set(['collection', 'api', 'fields', 'timestamps', 'softDelete']), name);
    if (typeof definition.collection !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(definition.collection) || !isSafeKey(definition.collection)) throw new Error(`Invalid collection for ${name}`);
    if (model.byCollection.has(definition.collection)) throw new Error(`Duplicate collection ${definition.collection}`);
    const api = apiFormats(definition.api, defaults, name);
    if (!isObject(definition.fields)) throw new Error(`${name}.fields must be an object`);
    const flags = recordOptions({ timestamps: definition.timestamps as boolean | undefined, softDelete: definition.softDelete as boolean | undefined });
    const entity: Entity = {
      timestamps: definition.timestamps === undefined ? options.timestamps : flags.timestamps,
      softDelete: definition.softDelete === undefined ? options.softDelete : flags.softDelete,
      name,
      collection: definition.collection,
      api,
      primary: '',
      fields: Object.create(null),
      root: newNode('', { type: 'object' }),
    };
    for (const [path, field] of Object.entries(definition.fields).sort(([a], [b]) => a.split('.').length - b.split('.').length)) {
      checkField(path, field);
      addField(entity, path, field);
      if (field.primary) {
        if (entity.primary) throw new Error(`${name}: only one primary key is supported`);
        entity.primary = path;
        fieldAt(entity, path).required = true;
      }
    }
    if (!entity.primary) throw new Error(`${name}: primary key is required`);
    systemFields(entity, options);
    entityValidators.set(entity, ajv);
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
      const relation = linkRelation(node, target, node.source ?? entity.primary, node.target ?? target.primary);
      pathParts(relation.source);
      pathParts(relation.target);
    }
  // Выводим отсутствующие поля ключей из связей, без образцов записей.
  let pending = model.entities.flatMap((entity) =>
    Object.values(entity.fields)
      .filter((node): node is RelationNode => !!node.relation)
      .map((node) => ({ entity, node })),
  );
  while (pending.length) {
    let progress = false;
    pending = pending.filter(({ entity, node }) => {
      const target = node.relation;
      const targetField = target.fields[node.target];
      const sourceField = entity.fields[node.source];
      if (sourceField && targetField) return false;
      if (!sourceField && targetField && ['string', 'number'].includes(targetField.base) && !targetField.relation) {
        addField(entity, node.source, { type: targetField.base + (node.many && node.target === target.primary ? '[]' : ''), ...(node.nullable ? { nullable: true } : {}) }, true);
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
        const sourceField = entity.fields[node.source];
        const targetField = node.relation.fields[node.target];
        if (!sourceField || !targetField || sourceField.relation || targetField.relation || !['string', 'number'].includes(sourceField.base) || sourceField.base !== targetField.base)
          throw new Error(`Incompatible relation keys: ${entity.name}.${node.path}`);
      } else {
        if (node.enum) {
          const scalar = valueSchema({ ...node, many: false, nullable: false });
          const validateEnum = ajv.compile(scalar);
          for (const [index, value] of node.enum.entries()) {
            if (typeof value !== node.base || (typeof value === 'number' && !Number.isFinite(value)) || !validateEnum(value)) throw new Error(`Invalid enum[${index}]: ${entity.name}.${node.path}`);
          }
          ajv.removeSchema(scalar);
        }
        const schema = valueSchema(node);
        const validate = ajv.compile(schema);
        for (const key of ['default', 'example'] as const) if (node[key] !== undefined && !validate(structuredClone(node[key]))) throw new Error(`Invalid ${key}: ${entity.name}.${node.path}`);
        ajv.removeSchema(schema);
      }
    }
  markRelationKeys(model);
  for (const entity of model.entities) {
    const check = (node: Node, inArray = false, protectedParent = false): void => {
      if (inArray && node.readOnly && !protectedParent) throw new Error(`Read-only fields inside arrays require a readOnly parent: ${entity.name}.${node.path}`);
      for (const child of Object.values(node.children)) check(child, inArray || node.many, protectedParent || !!node.readOnly);
    };
    check(entity.root);
  }
  return model;
}
