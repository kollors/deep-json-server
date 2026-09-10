import { randomUUID } from 'node:crypto';
import type { DatabaseStore } from './database.js';
import { createId, validateDatabase } from './database.js';
import { childName, type Entity, inferModel, type Model, type Node, pathParts, readPath, validateRecord } from './model.js';
import { matchesWhere } from './query/filter.js';
import { badQuery, childrenOf, type ListOptions, nodeAt, ownScope, type RestOptions, type Scope, validateNested, validateScope } from './query/options.js';
import type { DatabaseData, DatabaseRecord, JsonObject, JsonValue } from './types.js';
import { createHttpError, isObject } from './utils.js';
export interface Ref {
  entity: Entity;
  node: Node;
  value: JsonObject;
  root: JsonObject;
  bindings: Record<string, JsonObject>;
  context: Context;
}
export interface Context {
  data: DatabaseData;
  model: Model;
  indexes: Map<string, Map<string, JsonObject[]>>;
}
export interface Page {
  data: Ref[];
  total: number;
}
export const makeContext = (data: DatabaseData, model: Model): Context => ({ data, model, indexes: new Map() });
export const rootRef = (context: Context, entity: Entity, value: JsonObject): Ref => ({ context, entity, node: entity.root, value, root: value, bindings: {} });
const keyOf = (value: unknown): string => `${typeof value}:${String(value)}`;
function sourceValues(ref: Ref, node: Node): unknown[] {
  const path = node.source as string;
  const binding = Object.keys(ref.bindings)
    .filter((prefix) => path === prefix || path.startsWith(`${prefix}.`))
    .sort((a, b) => b.length - a.length)[0];
  return binding ? readPath(ref.bindings[binding], path === binding ? [] : path.slice(binding.length + 1)) : readPath(ref.root, path);
}
export function related(ref: Ref, node: Node): Ref[] {
  const entity = node.relation as Entity;
  const indexKey = `${entity.name}:${node.target}`;
  let index = ref.context.indexes.get(indexKey);
  if (!index) {
    index = new Map();
    for (const record of ref.context.data[entity.collection] ?? [])
      for (const value of readPath(record, node.target as string)) {
        const key = keyOf(value);
        const bucket = index.get(key) ?? [];
        bucket.push(record);
        index.set(key, bucket);
      }
    ref.context.indexes.set(indexKey, index);
  }
  const found = new Set<JsonObject>();
  for (const value of sourceValues(ref, node)) for (const record of index.get(keyOf(value)) ?? []) found.add(record);
  return [...found].map((record) => rootRef(ref.context, entity, record));
}
export function resolveField(ref: Ref, node: Node): unknown {
  if (node.relation) {
    const records = related(ref, node);
    return node.many ? records : (records[0] ?? null);
  }
  const key = childName(node);
  const value = Object.hasOwn(ref.value, key) ? ref.value[key] : undefined;
  if (node.base !== 'object' || value == null) return value;
  const wrap = (object: JsonObject): Ref => ({ ...ref, node, value: object, bindings: { ...ref.bindings, [node.path]: object } });
  if (Array.isArray(value)) return value.every(isObject) ? (value as JsonObject[]).map(wrap) : value;
  return isObject(value) ? wrap(value as JsonObject) : value;
}
const isRef = (value: unknown): value is Ref => isObject(value) && 'context' in value && 'bindings' in value;
function filterView(ref: Ref): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(childrenOf(ref.node)))
    if (!node.writeOnly)
      Object.defineProperty(value, name, {
        enumerable: true,
        get: () => {
          const field = resolveField(ref, node);
          return isRef(field) ? filterView(field) : Array.isArray(field) ? field.map((v) => (isRef(v) ? filterView(v) : v)) : field;
        },
      });
  return value;
}
function validateWhere(node: Node, where: unknown, depth = 0): void {
  if (!isObject(where) || depth > 32) badQuery('where must be an object with depth at most 32');
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(condition) || (key === 'or' && !condition.length)) badQuery(`Invalid ${key}`);
      condition.forEach((c) => {
        validateWhere(node, c, depth + 1);
      });
      continue;
    }
    if (key === 'not') {
      validateWhere(node, condition, depth + 1);
      continue;
    }
    const field = childrenOf(node)[key];
    if (!field || field.writeOnly) badQuery(`Unknown or inaccessible filter field ${key}`);
    validateCondition(field, condition, depth + 1);
  }
}
function validateCondition(node: Node, condition: unknown, depth: number): void {
  if (!isObject(condition) || depth > 32) badQuery('Field filter must contain operators');
  if (node.relation || node.base === 'object') {
    if (!node.many) {
      validateWhere(node, condition, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(condition)) {
      if (!['some', 'every', 'none', 'not'].includes(key)) badQuery(`Unknown array operator ${key}`);
      if (key === 'not') validateCondition(node, value, depth + 1);
      else validateWhere(node, value, depth + 1);
    }
    return;
  }
  const validate = (value: unknown): boolean => value === null || typeof value === node.base;
  for (const [operator, value] of Object.entries(condition)) {
    if (operator === 'not') {
      validateCondition(node, value, depth + 1);
      continue;
    }
    if (node.many && ['some', 'every', 'none'].includes(operator)) {
      validateCondition({ ...node, many: false }, value, depth + 1);
      continue;
    }
    const allowed = node.many
      ? ['contains', 'in']
      : ['eq', 'ne', 'in', ...(node.base === 'boolean' ? [] : ['gt', 'gte', 'lt', 'lte']), ...(node.base === 'string' ? ['contains', 'startsWith', 'endsWith'] : [])];
    if (!allowed.includes(operator)) badQuery(`Invalid operator ${operator} for ${node.type}`);
    const values = operator === 'in' ? value : [value];
    if (!Array.isArray(values) || values.some((v) => !validate(v))) badQuery(`Invalid value for ${operator}`);
    if (['contains', 'startsWith', 'endsWith', 'gt', 'gte', 'lt', 'lte'].includes(operator) && value === null) badQuery(`Null is not allowed for ${operator}`);
  }
}
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export class Engine {
  constructor(
    readonly store: DatabaseStore,
    public model: Model,
    readonly pageSize = 10,
    readonly maxPageSize = 100,
  ) {}
  async context(): Promise<Context> {
    const data = await this.store.read();
    if (!this.model.explicit) this.model = inferModel(data);
    return makeContext(data, this.model);
  }
  entity(collection: string): Entity {
    const entity = this.model.byCollection.get(collection);
    if (!entity) throw createHttpError(404, 'Resource not found');
    return entity;
  }
  records(context: Context, entity: Entity): Ref[] {
    return (context.data[entity.collection] ?? []).map((value) => rootRef(context, entity, value));
  }
  find(context: Context, entity: Entity, key: unknown): Ref | undefined {
    return this.records(context, entity).find((ref) => String(ref.value[entity.primary]) === String(key));
  }
  validateOptions(node: Node, options: ListOptions): { page: number; pageSize: number } {
    if (options.where !== undefined) validateWhere(node, options.where);
    if (options.order !== undefined) {
      if (!Array.isArray(options.order)) badQuery('order must be an array');
      for (const rule of options.order) {
        if (!isObject(rule) || Object.keys(rule).some((k) => !['field', 'direction'].includes(k)) || typeof rule.field !== 'string' || !['ASC', 'DESC'].includes(rule.direction))
          badQuery('Invalid order rule');
        nodeAt(node, rule.field, true);
      }
    }
    if (options.pager !== undefined && (!isObject(options.pager) || Object.keys(options.pager).some((k) => !['page', 'pageSize'].includes(k)))) badQuery('Invalid pager');
    const page = options.pager?.page ?? 1;
    const pageSize = options.pager?.pageSize ?? this.pageSize;
    if (
      typeof page !== 'number' ||
      typeof pageSize !== 'number' ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > this.maxPageSize ||
      !Number.isSafeInteger((page - 1) * pageSize)
    )
      badQuery(`Invalid pager; pageSize must be 1..${this.maxPageSize}`);
    return { page, pageSize };
  }
  list(records: Ref[], node: Node, options: ListOptions = {}): Page {
    const { page, pageSize } = this.validateOptions(node, options);
    const data = options.where ? records.filter((ref) => matchesWhere(filterView(ref), options.where)) : [...records];
    const rules = (options.order ?? []).map((rule) => ({ ...rule, keys: pathParts(rule.field) }));
    if (rules.length)
      data.sort((a, b) => {
        for (const rule of rules) {
          const left = readPath(a.value, rule.keys)[0];
          const right = readPath(b.value, rule.keys)[0];
          const comparison =
            left == null && right == null
              ? 0
              : left == null
                ? 1
                : right == null
                  ? -1
                  : typeof left === 'number' && typeof right === 'number'
                    ? left - right
                    : collator.compare(String(left), String(right));
          if (comparison) return rule.direction === 'DESC' ? -comparison : comparison;
        }
        return 0;
      });
    return { data: data.slice((page - 1) * pageSize, page * pageSize), total: data.length };
  }
  validateRest(entity: Entity, options: RestOptions): void {
    validateScope(entity.root, options.scope);
    validateNested(entity.root, options.scope, options.nested);
    for (const [path, nested] of Object.entries(options.nested)) this.validateOptions(nodeAt(entity.root, path), nested);
  }
  project(ref: Ref, scope: Scope = ownScope, nested: RestOptions['nested'] = {}, prefix = ''): JsonObject {
    const output: JsonObject = {};
    const children = childrenOf(ref.node);
    for (const [key, node] of Object.entries(children)) {
      if (node.writeOnly || (!Object.hasOwn(scope, key) && !(Object.hasOwn(scope, '*') && !node.relation))) continue;
      const value = resolveField(ref, node);
      const selection = Object.hasOwn(scope, key) ? (scope[key] ?? ownScope) : ownScope;
      const path = prefix + key;
      if (value === undefined) continue;
      if (isRef(value)) output[key] = this.project(value, selection, nested, `${path}.`);
      else if (node.many && (node.relation || node.base === 'object') && Array.isArray(value) && value.every(isRef)) {
        const page = this.list(value as Ref[], node, nested[path]);
        output[key] = { data: page.data.map((v) => this.project(v, selection, nested, `${path}.`)), total: page.total };
      } else output[key] = structuredClone(value) as JsonValue;
    }
    // Schemaless REST includes all raw fields, including fields absent in earlier records.
    if (!ref.context.model.explicit && scope['*'] === null)
      for (const [key, value] of Object.entries(ref.value)) if (!Object.hasOwn(output, key) && !children[key]?.relation) output[key] = structuredClone(value);
    return output;
  }
  validateData(data: DatabaseData): void {
    if (!this.model.explicit) return;
    for (const collection of Object.keys(data)) if (!this.model.byCollection.has(collection)) throw createHttpError(400, `Undeclared collection ${collection}`);
    const context = makeContext(data, this.model);
    const visit = (ref: Ref): void => {
      for (const node of Object.values(ref.node.children)) {
        if (node.relation) {
          const matches = related(ref, node);
          if (!node.many && matches.length > 1) throw createHttpError(400, `Multiple targets for ${ref.entity.name}.${node.path}`);
          if (node.required && !matches.length) throw createHttpError(400, `Required relation ${ref.entity.name}.${node.path} is empty`);
          const values = sourceValues(ref, node);
          if (node.source !== ref.entity.primary && values.some((value) => !matches.some((match) => readPath(match.value, node.target as string).some((target) => keyOf(target) === keyOf(value)))))
            throw createHttpError(400, `Dangling relation ${ref.entity.name}.${node.path}`);
        } else if (node.base === 'object') {
          const child = resolveField(ref, node);
          if (Array.isArray(child))
            child.forEach((v) => {
              visit(v as Ref);
            });
          else if (isRef(child)) visit(child);
        }
      }
    };
    for (const entity of this.model.entities)
      for (const record of data[entity.collection] ?? []) {
        validateRecord(entity, record, 'stored');
        visit(rootRef(context, entity, record));
      }
  }
  private defaults(node: Node, record: JsonObject): void {
    for (const [key, child] of Object.entries(node.children)) {
      if (child.relation) continue;
      if (!Object.hasOwn(record, key) && child.default !== undefined) record[key] = structuredClone(child.default);
      if (child.base === 'object' && record[key] != null) {
        const values = child.many ? (record[key] as JsonObject[]) : [record[key] as JsonObject];
        values.forEach((value) => {
          this.defaults(child, value);
        });
      }
    }
  }
  async mutate(entity: Entity, mode: 'create' | 'replace' | 'update' | 'delete', key?: unknown, body?: unknown): Promise<Ref> {
    if (mode !== 'delete') {
      if (!isObject(body)) throw createHttpError(400, 'Request body must be an object');
      if (this.model.explicit) validateRecord(entity, body, mode);
      else if (Object.hasOwn(body, 'id')) throw createHttpError(400, 'id is generated and immutable');
    }
    return this.store.update((database) => {
      // Reserve the highest existing generated value before any deletion or replacement.
      for (const owner of this.model.entities)
        for (const [field, definition] of Object.entries(owner.root.children))
          if (definition.generated === 'increment') {
            database.counters ??= {};
            const counters = database.counters;
            const name = `${owner.collection}.${field}`;
            const maximum = (database.data[owner.collection] ?? []).reduce((max, row) => (typeof row[field] === 'number' ? Math.max(max, row[field] as number) : max), counters[name] ?? 0);
            if (!Number.isSafeInteger(maximum) || maximum < 0) throw createHttpError(409, 'Invalid increment counter');
            counters[name] = maximum;
          }
      const context = makeContext(database.data, this.model);
      const current = mode === 'create' ? undefined : this.find(context, entity, key);
      if (mode !== 'create' && !current) throw createHttpError(404, 'Record not found');
      database.data[entity.collection] ??= [];
      const collection = database.data[entity.collection];
      if (mode === 'delete') {
        const snapshot = structuredClone(database.data);
        this.cascade(context, current as Ref);
        this.validateData(database.data);
        return rootRef(makeContext(snapshot, this.model), entity, (current as Ref).value);
      }
      const record = (mode === 'update' ? { ...current?.value, ...(structuredClone(body) as JsonObject) } : structuredClone(body)) as DatabaseRecord;
      if (mode !== 'create') {
        record[entity.primary] = (current as Ref).value[entity.primary];
        for (const [name, field] of Object.entries(entity.root.children)) if ((field.generated || field.readOnly) && current?.value[name] !== undefined) record[name] = current.value[name];
      }
      if (this.model.explicit) {
        if (mode !== 'update') this.defaults(entity.root, record);
        if (mode === 'create')
          for (const [name, field] of Object.entries(entity.root.children)) {
            if (field.generated === 'uuid') record[name] = randomUUID();
            if (field.generated === 'increment') {
              database.counters ??= {};
              const counters = database.counters;
              const counterKey = `${entity.collection}.${name}`;
              const largest = counters[counterKey] ?? 0;
              if (!Number.isSafeInteger(largest) || largest >= Number.MAX_SAFE_INTEGER) throw createHttpError(409, 'Increment key exhausted');
              record[name] = largest + 1;
              counters[counterKey] = largest + 1;
            }
          }
      } else if (mode === 'create') record.id = createId(collection);
      const collision = collection.some((v) => v !== current?.value && String(v[entity.primary]) === String(record[entity.primary]));
      if (collision) throw createHttpError(409, 'Primary key already exists');
      if (mode === 'create') collection.push(record);
      else collection[collection.indexOf((current as Ref).value)] = record;
      this.validateData(database.data);
      try {
        validateDatabase(database.data, new Map(this.model.entities.map((e) => [e.collection, e.primary])));
      } catch (error) {
        throw createHttpError(400, (error as Error).message);
      }
      return rootRef(makeContext(database.data, this.model), entity, record);
    });
  }
  private cascade(context: Context, initial: Ref): void {
    if (!this.model.explicit) {
      const rows = context.data[initial.entity.collection];
      rows.splice(rows.indexOf(initial.value), 1);
      return;
    }
    const deleted = new Set<JsonObject>([initial.value]);
    const survives = (ref: Ref) => !deleted.has(ref.value) && !deleted.has(ref.root) && !Object.values(ref.bindings).some((value) => deleted.has(value));
    const blocked: Array<{ owner: JsonObject; root: JsonObject; node: Node }> = [];
    const owners: Array<{ ref: Ref; node: Node; targets: Ref[] }> = [];
    const collect = (ref: Ref) => {
      for (const node of Object.values(ref.node.children)) {
        if (node.relation) owners.push({ ref, node, targets: related(ref, node) });
        else if (node.base === 'object') {
          const v = resolveField(ref, node);
          if (isRef(v)) collect(v);
          else if (Array.isArray(v))
            v.forEach((x) => {
              collect(x as Ref);
            });
        }
      }
    };
    for (const entity of this.model.entities) this.records(context, entity).forEach(collect);
    let changed = true;
    while (changed) {
      changed = false;
      for (const { ref, node, targets } of owners)
        if (survives(ref) && targets.some((v) => deleted.has(v.value))) {
          if (node.onDelete === 'cascade') {
            deleted.add(ref.value);
            changed = true;
          }
        }
    }
    for (const { ref, node, targets } of owners) if (survives(ref) && targets.some((v) => deleted.has(v.value))) blocked.push({ owner: ref.value, root: ref.root, node });
    if (blocked.length) throw createHttpError(409, `Delete restricted by ${blocked[0].node.path}`);
    const prune = (node: Node, record: JsonObject): void => {
      for (const [key, child] of Object.entries(node.children))
        if (!child.relation && child.base === 'object' && record[key] != null) {
          if (child.many) {
            record[key] = (record[key] as JsonObject[]).filter((v) => !deleted.has(v));
            (record[key] as JsonObject[]).forEach((v) => {
              prune(child, v);
            });
          } else if (deleted.has(record[key] as JsonObject)) delete record[key];
          else prune(child, record[key] as JsonObject);
        }
    };
    for (const entity of this.model.entities) {
      context.data[entity.collection] = (context.data[entity.collection] ?? []).filter((record) => !deleted.has(record));
      context.data[entity.collection].forEach((record) => {
        prune(entity.root, record);
      });
    }
  }
}
