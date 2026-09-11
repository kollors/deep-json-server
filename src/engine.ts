import { randomUUID } from 'node:crypto';
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './constants.js';
import type { DatabaseStore } from './database.js';
import { createId } from './database.js';
import { domainError } from './errors.js';
import { childName, type Entity, inferModel, type Model, type Node, pathParts, readPath, validateRecord } from './model.js';
import { compileWhere, type Predicate } from './query/filter.js';
import { badQuery, childrenOf, type ListOptions, nodeAt } from './query/options.js';
import type { DatabaseData, DatabaseRecord, JsonObject } from './types.js';
import { isObject } from './utils.js';

const REF = Symbol('record reference');
export interface Ref {
  [REF]: true;
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
export interface PreparedList {
  page: number;
  pageSize: number;
  predicate?: Predicate;
  rules: Array<{ direction: 'ASC' | 'DESC'; keys: string[] }>;
}
export interface Page {
  data: Ref[];
  total: number;
}
export const makeContext = (data: DatabaseData, model: Model): Context => ({ data, model, indexes: new Map() });
export const rootRef = (context: Context, entity: Entity, value: JsonObject): Ref => ({ [REF]: true, context, entity, node: entity.root, value, root: value, bindings: {} });
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
  const indexKey = `${entity.collection}:${node.target}`;
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
  if ((ref.context.model.explicit && node.base !== 'object') || value == null) return value;
  const wrap = (object: JsonObject): Ref => ({ ...ref, node, value: object, bindings: { ...ref.bindings, [node.path]: object } });
  if (Array.isArray(value)) return value.every(isObject) ? (value as JsonObject[]).map(wrap) : value;
  return isObject(value) ? wrap(value as JsonObject) : value;
}
export const isRef = (value: unknown): value is Ref => isObject(value) && (value as Partial<Ref>)[REF] === true;
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
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export class Engine {
  private inferredModels = new WeakMap<DatabaseData, Model>();
  constructor(
    readonly store: DatabaseStore,
    public model: Model,
    readonly pageSize = DEFAULT_PAGE_SIZE,
    readonly maxPageSize = DEFAULT_MAX_PAGE_SIZE,
  ) {
    this.inferredModels.set(store.database.data, model);
  }
  private modelFor(data: DatabaseData): Model {
    if (this.model.explicit) return this.model;
    let model = this.inferredModels.get(data);
    if (!model) {
      model = inferModel(data);
      this.inferredModels.set(data, model);
    }
    return model;
  }
  async context(): Promise<Context> {
    const data = await this.store.read();
    if (!this.model.explicit) this.model = this.modelFor(data);
    return makeContext(data, this.model);
  }
  records(context: Context, entity: Entity): Ref[] {
    return (context.data[entity.collection] ?? []).map((value) => rootRef(context, entity, value));
  }
  find(context: Context, entity: Entity, key: unknown): Ref | undefined {
    const value = (context.data[entity.collection] ?? []).find((record) => String(record[entity.primary]) === String(key));
    return value ? rootRef(context, entity, value) : undefined;
  }
  prepareOptions(node: Node, options: ListOptions = {}): PreparedList {
    const predicate = options.where !== undefined ? compileWhere(node, options.where) : undefined;
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
    return { page, pageSize, predicate, rules: (options.order ?? []).map((rule) => ({ direction: rule.direction, keys: pathParts(rule.field) })) };
  }
  list(records: Ref[], node: Node, options: ListOptions = {}, prepared = this.prepareOptions(node, options)): Page {
    const { page, pageSize, predicate, rules } = prepared;
    const data = predicate ? records.filter((ref) => predicate(filterView(ref))) : [...records];
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
  validateData(data: DatabaseData): void {
    if (!this.model.explicit) return;
    for (const collection of Object.keys(data)) if (!this.model.byCollection.has(collection)) throw domainError('INVALID_INPUT', `Undeclared collection ${collection}`);
    const context = makeContext(data, this.model);
    const visit = (ref: Ref): void => {
      for (const node of Object.values(ref.node.children)) {
        if (node.relation) {
          const matches = related(ref, node);
          if (!node.many && matches.length > 1) throw domainError('INVALID_INPUT', `Multiple targets for ${ref.entity.name}.${node.path}`);
          if (node.required && !matches.length) throw domainError('INVALID_INPUT', `Required relation ${ref.entity.name}.${node.path} is empty`);
          const values = sourceValues(ref, node);
          if (node.source !== ref.entity.primary && values.some((value) => !matches.some((match) => readPath(match.value, node.target as string).some((target) => keyOf(target) === keyOf(value)))))
            throw domainError('INVALID_INPUT', `Dangling relation ${ref.entity.name}.${node.path}`);
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
  private preserve(node: Node, record: JsonObject, previous?: JsonObject): void {
    for (const [key, child] of Object.entries(node.children)) {
      if (child.relation) continue;
      if ((child.generated || child.readOnly) && previous && Object.hasOwn(previous, key)) record[key] = structuredClone(previous[key]);
      else if (child.base === 'object' && !child.many) {
        const old = previous?.[key];
        if (isObject(record[key])) this.preserve(child, record[key] as JsonObject, isObject(old) ? (old as JsonObject) : undefined);
        else if (record[key] === undefined && isObject(old)) {
          const preserved: JsonObject = {};
          this.preserve(child, preserved, old as JsonObject);
          if (Object.keys(preserved).length) record[key] = preserved;
        }
      }
    }
  }
  async mutate<T = Ref>(entity: Entity, mode: 'create' | 'replace' | 'update' | 'delete', key?: unknown, body?: unknown, prepare?: (ref: Ref) => T): Promise<T> {
    if (mode !== 'delete') {
      if (!isObject(body)) throw domainError('INVALID_INPUT', 'Request body must be an object');
      if (this.model.explicit) validateRecord(entity, body, mode);
      else if (Object.hasOwn(body, 'id')) throw domainError('INVALID_INPUT', 'id is generated and immutable');
    }
    const outcome = await this.store.update((database) => {
      const finish = (data: DatabaseData, record: JsonObject) => {
        const model = this.modelFor(data);
        const currentEntity = model.byCollection.get(entity.collection) as Entity;
        const ref = rootRef(makeContext(data, model), currentEntity, record);
        const output = prepare ? prepare(ref) : (ref as T);
        return { model: data === database.data || this.model.explicit ? model : this.modelFor(database.data), output };
      };
      // Reserve the highest existing generated value before any deletion or replacement.
      for (const owner of this.model.entities)
        for (const [field, definition] of Object.entries(owner.root.children))
          if (definition.generated === 'increment') {
            database.counters ??= {};
            const counters = database.counters;
            const name = `${owner.collection}.${field}`;
            const maximum = (database.data[owner.collection] ?? []).reduce((max, row) => (typeof row[field] === 'number' ? Math.max(max, row[field] as number) : max), counters[name] ?? 0);
            if (!Number.isSafeInteger(maximum) || maximum < 0) throw domainError('CONFLICT', 'Invalid increment counter');
            counters[name] = maximum;
          }
      const context = makeContext(database.data, this.model);
      const current = mode === 'create' ? undefined : this.find(context, entity, key);
      if (mode !== 'create' && !current) throw domainError('NOT_FOUND', 'Record not found');
      database.data[entity.collection] ??= [];
      const collection = database.data[entity.collection];
      if (mode === 'delete') {
        const snapshot = structuredClone(database.data);
        this.cascade(context, current as Ref);
        this.validateData(database.data);
        return finish(snapshot, (current as Ref).value);
      }
      const record = (mode === 'update' ? { ...current?.value, ...(structuredClone(body) as JsonObject) } : structuredClone(body)) as DatabaseRecord;
      if (mode !== 'create') {
        record[entity.primary] = (current as Ref).value[entity.primary];
        this.preserve(entity.root, record, current?.value);
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
              if (!Number.isSafeInteger(largest) || largest >= Number.MAX_SAFE_INTEGER) throw domainError('CONFLICT', 'Increment key exhausted');
              record[name] = largest + 1;
              counters[counterKey] = largest + 1;
            }
          }
      } else if (mode === 'create') record.id = createId(collection);
      const collision = collection.some((v) => v !== current?.value && String(v[entity.primary]) === String(record[entity.primary]));
      if (collision) throw domainError('CONFLICT', 'Primary key already exists');
      if (mode === 'create') collection.push(record);
      else collection[collection.indexOf((current as Ref).value)] = record;
      this.validateData(database.data);
      return finish(database.data, record);
    });
    this.model = outcome.model;
    return outcome.output;
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
    if (blocked.length) throw domainError('CONFLICT', `Delete restricted by ${blocked[0].node.path}`);
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
