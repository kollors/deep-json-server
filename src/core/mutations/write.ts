import { randomUUID } from 'node:crypto';
import { createId, type DatabaseContainer } from '../database.js';
import { domainError } from '../errors.js';
import { AUDIT_FIELDS } from '../lifecycle/options.js';
import { bindingFor, canWriteKey, type Entity, isReverseRelation, type Model, type Node, pathParts, readPath, validateRecord } from '../model.js';
import { keyOf, makeContext, type Ref, related, rootRef, sourceValues } from '../records.js';
import type { JsonObject, JsonValue } from '../types.js';
import { isEqual, isObject } from '../utils.js';

type WriteMode = 'create' | 'replace' | 'update';
interface Slot {
  object: JsonObject;
  key: string;
  field: Node;
}
interface Selection {
  ref: Ref;
  node: Node;
  value: unknown;
  omitted: boolean;
}

/** Выполняет вложенные изменения в общем черновике транзакции. */
export class MutationWriter {
  private indexes = new Map<Entity, Map<string, JsonObject>>();
  private active = new Set<JsonObject>();
  private selections: Array<{ ref: Ref; node: Node; targets: JsonObject[] }> = [];
  constructor(
    private database: DatabaseContainer,
    private model: Model,
    private existingMode: 'replace' | 'update',
    private beforeWrite: (entity: Entity, record: JsonObject) => void = () => {},
  ) {}

  write(entity: Entity, mode: WriteMode, key: unknown, body: unknown, depth = 0): JsonObject {
    if (depth > 32) throw domainError('INVALID_INPUT', 'Nested writes are too deep');
    if (!isObject(body)) throw domainError('INVALID_INPUT', 'Record input must be an object');
    if (Object.keys(body).some((name) => entity.fields[name]?.system)) throw domainError('INVALID_INPUT', 'System fields are read-only');
    if (this.model.explicit) validateRecord(entity, body, mode, true);
    else if (Object.hasOwn(body, entity.primary)) throw domainError('INVALID_INPUT', 'id is generated and immutable');
    this.database.data[entity.collection] ??= [];
    const collection = this.database.data[entity.collection];
    const index = this.index(entity);
    const current = mode === 'create' ? undefined : index.get(String(key));
    if (mode !== 'create' && !current) throw domainError('NOT_FOUND', `${entity.name}: record not found`);
    if (current && this.active.has(current)) throw domainError('CONFLICT', 'A nested write cannot modify an active ancestor record');
    if (current) this.beforeWrite(entity, current);
    const input = structuredClone(body) as JsonObject;
    const next: JsonObject = mode === 'update' ? { ...current, ...input } : { ...input };
    if (current) {
      next[entity.primary] = current[entity.primary];
      this.preserve(entity.root, next, current);
      for (const name of AUDIT_FIELDS) if (!entity.fields[name] && Object.hasOwn(current, name)) next[name] = current[name];
    }
    if (this.model.explicit) {
      if (mode !== 'update') this.defaults(entity.root, next);
      if (mode === 'create') this.generate(entity, next);
    } else if (mode === 'create') next.id = createId(collection);
    const duplicate = index.get(String(next[entity.primary]));
    if (duplicate && duplicate !== current) throw domainError('CONFLICT', 'Primary key already exists');
    // Сохраняем ссылки на объекты, чтобы вложенные обращения видели одну и ту же запись черновика.
    const record = current ?? {};
    for (const name of Object.keys(record)) delete record[name];
    Object.assign(record, next);
    if (!current) {
      collection.push(record);
      index.set(String(record[entity.primary]), record);
    }
    this.active.add(record);
    try {
      const pending: Selection[] = [];
      this.extract(rootRef(makeContext(this.database.data, this.model), entity, record), input, {}, pending, mode === 'replace', depth);
      for (const selection of pending) this.connect(selection, depth);
      return record;
    } finally {
      this.active.delete(record);
    }
  }

  private extract(ref: Ref, input: JsonObject, inputBindings: Record<string, JsonObject>, pending: Selection[], replace: boolean, depth: number): void {
    if (depth > 32) throw domainError('INVALID_INPUT', 'Nested writes are too deep');
    for (const [name, node] of Object.entries(ref.node.children)) {
      if (node.relation) {
        const supplied = Object.hasOwn(ref.value, name);
        // При замене разрываем пропущенные обратные связи; прямые ключи заменяются вместе с записью.
        const omitted = !supplied && replace && isReverseRelation(ref.entity, node) && canWriteKey(node.relation, node.target as string);
        if (!supplied && !omitted) continue;
        if (supplied && node.source !== ref.entity.primary && this.slots(ref.entity, input, node.source as string, inputBindings).some(({ object, key }) => Object.hasOwn(object, key)))
          throw domainError('INVALID_INPUT', `Supply either ${node.path} or its source key ${node.source}`);
        pending.push({ ref, node, value: supplied ? ref.value[name] : node.many ? [] : null, omitted });
        delete ref.value[name];
      } else if (node.base === 'object' && ref.value[name] != null && !node.readOnly) {
        const values = Array.isArray(ref.value[name]) ? (ref.value[name] as JsonValue[]) : [ref.value[name]];
        const parentInput = inputBindings[ref.node.path] ?? input;
        const rawValue = parentInput[name];
        const raw = Array.isArray(rawValue) ? rawValue : [rawValue];
        for (const [index, value] of values.entries()) {
          if (!isObject(value)) continue;
          const inputValue = raw[index];
          this.extract(
            { ...ref, node, value: value as JsonObject, bindings: { ...ref.bindings, [node.path]: value as JsonObject } },
            input,
            isObject(inputValue) ? { ...inputBindings, [node.path]: inputValue as JsonObject } : inputBindings,
            pending,
            replace,
            depth + 1,
          );
        }
      }
    }
  }

  private resolve(entity: Entity, input: unknown, depth: number): JsonObject {
    const object = isObject(input);
    if (object && !Object.hasOwn(input, entity.primary)) return this.write(entity, 'create', undefined, input, depth + 1);
    const key = object ? input[entity.primary] : input;
    const primary = entity.fields[entity.primary];
    if (!['string', 'number'].includes(typeof key) || (this.model.explicit && typeof key !== primary.base)) throw domainError('INVALID_INPUT', `${entity.name}.${entity.primary}: invalid key type`);
    const current = this.index(entity).get(String(key));
    if (!current || keyOf(current[entity.primary]) !== keyOf(key)) throw domainError('NOT_FOUND', `${entity.name}: related record not found`);
    if (!object) return current;
    const data = { ...input };
    delete data[entity.primary];
    return this.write(entity, this.existingMode, key, data, depth + 1);
  }

  private connect({ ref, node, value, omitted }: Selection, depth: number): void {
    const target = node.relation as Entity;
    if (value === null && (node.many || (!omitted && !node.nullable))) throw domainError('INVALID_INPUT', `${node.path} cannot be null`);
    if (node.many && !Array.isArray(value)) throw domainError('INVALID_INPUT', `${node.path} must be an array`);
    if (!node.many && Array.isArray(value)) throw domainError('INVALID_INPUT', `${node.path} must be a record or key`);
    const entries = value === null ? [] : node.many ? (value as unknown[]) : [value];
    const targets = entries.map((entry) => this.resolve(target, entry, depth));
    if (new Set(targets).size !== targets.length) throw domainError('INVALID_INPUT', `Duplicate record in ${node.path}`);
    if (!isReverseRelation(ref.entity, node)) {
      const slots = this.slots(ref.entity, ref.root, node.source as string, ref.bindings, true);
      if (slots.length !== 1) throw domainError('INVALID_INPUT', `Ambiguous source ${node.source}; supply its storage keys explicitly`);
      const keys = targets.flatMap((record) => {
        const values = readPath(record, node.target as string);
        if (!values.length) throw domainError('INVALID_INPUT', `Related record has no ${node.target}`);
        return values;
      });
      const unique = [...new Map(keys.map((key) => [keyOf(key), key as JsonValue])).values()];
      if (!slots[0].field.many && unique.length > 1) throw domainError('INVALID_INPUT', `${node.source} cannot store multiple relation keys`);
      this.set(ref.entity, slots[0], slots[0].field.many ? unique : (unique[0] ?? (slots[0].field.nullable ? null : undefined)));
    } else {
      const keys = sourceValues(ref, node);
      if (keys.length !== 1) throw domainError('INVALID_INPUT', `Relation ${node.path} needs one source key`);
      const key = keys[0] as JsonValue;
      const previous = related({ ...ref, context: makeContext(this.database.data, this.model) }, node);
      for (const match of previous)
        if (!targets.includes(match.value)) {
          for (const slot of this.slots(target, match.value, node.target as string)) {
            const old = slot.object[slot.key];
            if (Array.isArray(old))
              this.set(
                target,
                slot,
                old.filter((v) => keyOf(v) !== keyOf(key)),
              );
            else if (keyOf(old) === keyOf(key)) this.set(target, slot, slot.field.nullable ? null : undefined);
          }
        }
      for (const record of targets) {
        if (readPath(record, node.target as string).some((v) => keyOf(v) === keyOf(key))) continue;
        const slots = this.slots(target, record, node.target as string, {}, true);
        if (slots.length !== 1) throw domainError('INVALID_INPUT', `Ambiguous target ${node.target}; supply its object or array explicitly`);
        const slot = slots[0];
        this.set(target, slot, slot.field.many ? [...(Array.isArray(slot.object[slot.key]) ? (slot.object[slot.key] as JsonValue[]) : []), key] : key);
      }
    }
    this.selections.push({ ref, node, targets });
  }

  validateRelations(): void {
    const context = makeContext(this.database.data, this.model);
    for (const { ref, node, targets } of this.selections) {
      if (Object.entries(ref.bindings).some(([path, value]) => !readPath(ref.root, path).includes(value))) throw domainError('CONFLICT', `Nested writes conflict at ${node.path}`);
      const actual = related({ ...ref, context }, node).map((record) => record.value);
      if (actual.length !== targets.length || targets.some((target) => !actual.includes(target))) throw domainError('CONFLICT', `Relation ${node.path} cannot represent the requested records`);
    }
  }

  private index(entity: Entity): Map<string, JsonObject> {
    let index = this.indexes.get(entity);
    if (!index) {
      index = new Map((this.database.data[entity.collection] ?? []).map((record) => [String(record[entity.primary]), record]));
      this.indexes.set(entity, index);
    }
    return index;
  }

  private set(entity: Entity, slot: Slot, value: JsonValue | undefined): void {
    if (isEqual(slot.object[slot.key], value)) return;
    if (!canWriteKey(entity, slot.field.path)) throw domainError('INVALID_INPUT', `Cannot change protected relation key ${entity.name}.${slot.field.path}`);
    if (value === undefined) delete slot.object[slot.key];
    else slot.object[slot.key] = value;
  }

  private slots(entity: Entity, root: JsonObject, path: string, bindings: Record<string, JsonObject> = {}, create = false): Slot[] {
    const binding = bindingFor(bindings, path);
    const parts = pathParts(binding ? path.slice(binding.length + 1) : path);
    const field = entity.fields[path];
    if (!field) throw domainError('INVALID_INPUT', `Unknown relation key ${entity.name}.${path}`);
    const walk = (value: unknown, index: number): Slot[] => {
      if (Array.isArray(value)) return value.flatMap((item) => walk(item, index));
      if (!isObject(value)) return [];
      const key = parts[index];
      if (index === parts.length - 1) return [{ object: value as JsonObject, key, field }];
      const prefix = [binding, ...parts.slice(0, index + 1)].filter(Boolean).join('.');
      if (create && value[key] === undefined && !entity.fields[prefix]?.many) value[key] = {};
      return walk(value[key], index + 1);
    };
    return walk(binding ? bindings[binding] : root, 0);
  }

  private defaults(node: Node, record: JsonObject): void {
    for (const [key, child] of Object.entries(node.children)) {
      if (child.relation) continue;
      if (!Object.hasOwn(record, key) && child.default !== undefined) record[key] = structuredClone(child.default);
      if (child.base === 'object' && record[key] != null) {
        const values = child.many ? (record[key] as JsonObject[]) : [record[key] as JsonObject];
        for (const value of values) this.defaults(child, value);
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
  private generate(entity: Entity, record: JsonObject): void {
    for (const [name, field] of Object.entries(entity.root.children)) {
      if (field.generated === 'uuid') record[name] = randomUUID();
      if (field.generated === 'increment') {
        this.database.counters ??= {};
        const counters = this.database.counters;
        const key = `${entity.collection}.${name}`;
        const largest = counters[key] ?? 0;
        if (!Number.isSafeInteger(largest) || largest >= Number.MAX_SAFE_INTEGER) throw domainError('CONFLICT', 'Increment key exhausted');
        record[name] = largest + 1;
        counters[key] = largest + 1;
      }
    }
  }
}
