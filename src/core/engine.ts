import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './constants.js';
import type { DatabaseStore } from './database.js';
import { domainError } from './errors.js';
import { RecordMutation } from './lifecycle/mutation.js';
import type { Actor } from './lifecycle/options.js';
import { type Entity, inferModel, isReverseRelation, type Model, type Node, pathParts, readPath, validateRecord } from './model.js';
import { MutationWriter } from './mutations/write.js';
import { compileWhere, type Predicate } from './query/filter.js';
import { badQuery, childrenOf, type ListOptions, nodeAt } from './query/options.js';
import { type Context, isRef, keyOf, makeContext, type Ref, related, resolveField, rootRef, sourceValues } from './records.js';
import type { DatabaseData, JsonObject } from './types.js';
import { hasOnlyKeys, isObject } from './utils.js';

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
function filterView(ref: Ref): Record<string, unknown> {
  const value: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(childrenOf(ref.node)))
    if (!node.writeOnly)
      Object.defineProperty(value, name, {
        enumerable: true,
        get: () => {
          const field = resolveField(ref, node, true);
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
  /** Возвращает явную модель или кешированное описание, выведенное из переданного снимка данных.
   * @example Повторный вызов с тем же объектом data → тот же объект Model.
   */
  private modelFor(data: DatabaseData): Model {
    if (this.model.explicit) return this.model;
    let model = this.inferredModels.get(data);
    if (!model) {
      model = inferModel(data, this.model.options);
      this.inferredModels.set(data, model);
    }
    return model;
  }
  /** Читает актуальный снимок хранилища и создаёт контекст с пустым кешем индексов.
   * @example context() → Promise<Context>; при ошибке чтения хранилища → отклонённый Promise.
   */
  async context(): Promise<Context> {
    const data = await this.store.read();
    if (!this.model.explicit) this.model = this.modelFor(data);
    return makeContext(data, this.model);
  }
  /** Оборачивает все записи выбранной коллекции ссылками с контекстом.
   * @example Пустая коллекция → []; две записи → две ссылки Ref.
   */
  records(context: Context, entity: Entity): Ref[] {
    return (context.data[entity.collection] ?? []).map((value) => rootRef(context, entity, value));
  }
  /** Ищет запись по строковому представлению первичного ключа, включая удалённые записи.
   * @example Ключ '1' находит запись с числовым ключом 1; отсутствующий ключ → undefined.
   */
  find(context: Context, entity: Entity, key: unknown): Ref | undefined {
    const value = (context.data[entity.collection] ?? []).find((record) => String(record[entity.primary]) === String(key));
    return value ? rootRef(context, entity, value) : undefined;
  }
  /** Проверяет аргументы списка и подготавливает предикат, пути сортировки и размеры страницы.
   * @example pager: { page: 2, pageSize: 5 } → план с page: 2 и pageSize: 5; page: 0 → ошибка.
   */
  prepareOptions(node: Node, options: ListOptions = {}): PreparedList {
    const predicate = options.where !== undefined || node.softDelete || node.relation?.softDelete ? compileWhere(node, options.where ?? {}) : undefined;
    if (options.order !== undefined) {
      if (!Array.isArray(options.order)) badQuery('order must be an array');
      for (const rule of options.order) {
        if (!isObject(rule) || !hasOnlyKeys(rule, ['field', 'direction']) || typeof rule.field !== 'string' || !['ASC', 'DESC'].includes(rule.direction)) badQuery('Invalid order rule');
        nodeAt(node, rule.field, true);
      }
    }
    if (options.pager !== undefined && (!isObject(options.pager) || !hasOnlyKeys(options.pager, ['page', 'pageSize']))) badQuery('Invalid pager');
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
  /** Фильтрует, сортирует и возвращает страницу, не меняя порядок исходного массива.
   * @example Три подходящие записи, page: 2, pageSize: 2 → { data: [третья запись], total: 3 }.
   */
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
  /** Проверяет коллекции, значения полей и целостность активных связей.
   * @example Согласованные записи → undefined; обязательная связь без цели → исключение.
   */
  validateData(data: DatabaseData): void {
    if (!this.model.explicit) return;
    for (const collection of Object.keys(data)) if (!this.model.byCollection.has(collection)) throw domainError('INVALID_INPUT', `Undeclared collection ${collection}`);
    const context = makeContext(data, this.model);
    const visit = (ref: Ref): void => {
      for (const node of Object.values(ref.node.children)) {
        if (node.relation) {
          const matches = related(ref, node).filter((match) => !match.entity.softDelete || match.value.deletedAt == null);
          if (!node.many && matches.length > 1) throw domainError('INVALID_INPUT', `Multiple targets for ${ref.entity.name}.${node.path}`);
          if (node.required && !matches.length) throw domainError('INVALID_INPUT', `Required relation ${ref.entity.name}.${node.path} is empty`);
          const values = sourceValues(ref, node);
          if (!isReverseRelation(ref.entity, node) && values.some((value) => !matches.some((match) => readPath(match.value, node.target as string).some((target) => keyOf(target) === keyOf(value)))))
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
        if (!entity.softDelete || record.deletedAt == null) visit(rootRef(context, entity, record));
      }
  }
  /** Выполняет одну операцию записи в транзакции, включая связи, права и подготовку ответа.
   * @example Режим update с { name: 'Анна' } → обновлённая запись; ошибка проверки → прежние данные.
   */
  async mutate<T = Ref>(entity: Entity, mode: 'create' | 'replace' | 'update' | 'delete', key?: unknown, body?: unknown, prepare?: (ref: Ref) => T, actor?: Actor): Promise<T> {
    if (this.model.options.auth && !actor) throw domainError('UNAUTHENTICATED', 'Authentication required');
    if (mode !== 'delete') {
      if (!isObject(body)) throw domainError('INVALID_INPUT', 'Request body must be an object');
      if (!this.model.explicit && Object.hasOwn(body, 'id')) throw domainError('INVALID_INPUT', 'id is generated and immutable');
    }
    const outcome = await this.store.update((database) => {
      const lifecycle = new RecordMutation(database.data, this.model, actor);
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
      if (mode === 'delete') {
        const context = makeContext(database.data, this.model);
        const current = this.find(context, entity, key);
        if (!current) throw domainError('NOT_FOUND', 'Record not found');
        const snapshot = structuredClone(database.data);
        lifecycle.check(entity, current.value);
        if (entity.softDelete && current.value.deletedAt != null) return finish(database.data, current.value);
        this.cascade(context, current as Ref, lifecycle);
        lifecycle.finish();
        this.validateData(database.data);
        return finish(entity.softDelete ? database.data : snapshot, (current as Ref).value);
      }
      const writer = new MutationWriter(database, this.model, mode === 'replace' ? 'replace' : 'update', (owner, record) => lifecycle.write(owner, record));
      const record = writer.write(entity, mode, key, body);
      writer.validateRelations();
      lifecycle.finish();
      this.validateData(database.data);
      return finish(database.data, record);
    });
    this.model = outcome.model;
    return outcome.output;
  }
  /** Вычисляет каскад удаления, проверяет запрещающие связи и меняет только черновик данных.
   * @example Удаление родителя при cascade → удалённые зависимые записи; restrict → исключение.
   */
  private cascade(context: Context, initial: Ref, lifecycle: RecordMutation): void {
    if (!this.model.explicit) {
      lifecycle.deleteGroup(initial, new Set([initial.value]));
      if (!initial.entity.softDelete) {
        const rows = context.data[initial.entity.collection];
        rows.splice(rows.indexOf(initial.value), 1);
      }
      lifecycle.capturePruned(initial);
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
    for (const entity of this.model.entities)
      this.records(context, entity)
        .filter((ref) => !entity.softDelete || ref.value.deletedAt == null)
        .forEach(collect);
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
    lifecycle.deleteGroup(initial, deleted);
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
      context.data[entity.collection] = (context.data[entity.collection] ?? []).filter((record) => entity.softDelete || !deleted.has(record));
      context.data[entity.collection].forEach((record) => {
        if (!deleted.has(record)) prune(entity.root, record);
      });
    }
    lifecycle.capturePruned(initial);
  }
}
