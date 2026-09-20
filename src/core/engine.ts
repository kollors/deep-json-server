import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './constants.js';
import type { DatabaseStore } from './database.js';
import { domainError } from './errors.js';
import { RecordMutation } from './lifecycle/mutation.js';
import type { ActorSource } from './lifecycle/options.js';
import { type Entity, inferModel, isReverseRelation, type Model, type Node, readPath, validateRecord } from './model.js';
import { MutationWriter } from './mutations/write.js';
import type { MutationMode } from './operations.js';
import { executeList, type Page, type PreparedList, prepareList } from './query/execute.js';
import type { ListOptions } from './query/options.js';
import { type Context, isRef, keyOf, makeContext, type Ref, related, resolveField, rootRef, sourceValues } from './records.js';
import type { DatabaseData, DatabaseSnapshot, JsonObject } from './types.js';
import { defined, isObject } from './utils.js';

export type { Page, PreparedList } from './query/execute.js';
export class Engine {
  private inferredModels = new WeakMap<DatabaseSnapshot, Model>();
  private reservedCounters = new WeakSet<DatabaseSnapshot>();
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
  private modelFor(data: DatabaseSnapshot): Model {
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
    return prepareList(node, options, this.pageSize, this.maxPageSize);
  }
  /** Фильтрует, сортирует и возвращает страницу, не меняя порядок исходного массива.
   * @example Три подходящие записи, page: 2, pageSize: 2 → { data: [третья запись], total: 3 }.
   */
  list(records: Ref[], node: Node, options: ListOptions = {}, prepared = this.prepareOptions(node, options)): Page {
    return executeList(records, prepared);
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
        if (node.virtual) continue;
        if (node.relation) {
          const matches = related(ref, node).filter((match) => !match.entity.softDelete || match.value.deletedAt == null);
          if (!node.many && matches.length > 1) throw domainError('INVALID_INPUT', `Multiple targets for ${ref.entity.name}.${node.path}`);
          if (node.required && !matches.length) throw domainError('INVALID_INPUT', `Required relation ${ref.entity.name}.${node.path} is empty`);
          const values = sourceValues(ref, node);
          if (!isReverseRelation(ref.entity, node) && values.some((value) => !matches.some((match) => readPath(match.value, node.target).some((target) => keyOf(target) === keyOf(value)))))
            throw domainError('INVALID_INPUT', `Dangling relation ${ref.entity.name}.${node.path}`);
        } else if (node.base === 'object') {
          const child = resolveField(ref, node);
          if (Array.isArray(child))
            child.forEach((v) => {
              if (isRef(v)) visit(v);
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
  mutate(entity: Entity, mode: MutationMode, key?: unknown, body?: unknown, prepare?: undefined, actor?: ActorSource): Promise<Ref>;
  mutate<T>(entity: Entity, mode: MutationMode, key: unknown, body: unknown, prepare: (ref: Ref) => T, actor?: ActorSource): Promise<T>;
  async mutate<T>(entity: Entity, mode: MutationMode, key?: unknown, body?: unknown, prepare?: (ref: Ref) => T, actor?: ActorSource): Promise<T | Ref> {
    const currentActor = () => (typeof actor === 'function' ? actor() : actor);
    if (this.model.options.auth && !currentActor()) throw domainError('UNAUTHENTICATED', 'Authentication required');
    if (mode !== 'delete') {
      if (!isObject(body)) throw domainError('INVALID_INPUT', 'Request body must be an object');
      if (!this.model.explicit && Object.hasOwn(body, 'id')) throw domainError('INVALID_INPUT', 'id is generated and immutable');
    }
    const outcome = await this.store.update((database, before) => {
      // Используем описание того же снимка, который хранилище прочитало внутри очереди.
      this.model = this.modelFor(before);
      const currentEntity = this.model.byCollection.get(entity.collection);
      if (!currentEntity) throw domainError('NOT_FOUND', 'Resource not found');
      entity = currentEntity;
      // Пока запрос ждал очередь, токен мог быть отозван, а права пользователя — изменены.
      const lifecycle = new RecordMutation(database.data, this.model, currentActor(), before);
      const finish = (data: DatabaseData, record: JsonObject) => {
        const model = this.modelFor(data);
        const currentEntity = defined(model.byCollection.get(entity.collection), entity.collection);
        const ref = rootRef(makeContext(data, model), currentEntity, record);
        const output = prepare ? prepare(ref) : ref;
        return { model: data === database.data || this.model.explicit ? model : this.modelFor(database.data), output };
      };
      // Свой подтверждённый снимок уже содержит зарезервированные номера. Новый снимок с диска проверяем снова.
      if (!this.reservedCounters.has(before))
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
        lifecycle.check(entity, current.value);
        if (entity.softDelete && current.value.deletedAt != null) return finish(database.data, current.value);
        this.cascade(context, current, lifecycle);
        lifecycle.finish();
        this.validateData(database.data);
        return finish(entity.softDelete ? database.data : this.store.database.data, current.value);
      }
      const writer = new MutationWriter(database, this.model, mode === 'replace' ? 'replace' : 'update', (owner, record) => lifecycle.write(owner, record));
      const record = writer.write(entity, mode, key, body);
      writer.validateRelations();
      lifecycle.finish();
      this.validateData(database.data);
      return finish(database.data, record);
    });
    this.reservedCounters.add(this.store.database.data);
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
        const rows = defined(context.data[initial.entity.collection], initial.entity.collection);
        rows.splice(rows.indexOf(initial.value), 1);
      }
      lifecycle.capturePruned(initial);
      return;
    }
    const deleted = new Set<JsonObject>([initial.value]);
    const survives = (ref: Ref) => !deleted.has(ref.value) && !deleted.has(ref.root) && !Object.values(ref.bindings).some((value) => deleted.has(value));
    type Dependency = { ref: Ref; node: Node; targets: Ref[] };
    const owners: Dependency[] = [];
    const dependents = new Map<JsonObject, Dependency[]>();
    const collect = (ref: Ref) => {
      for (const node of Object.values(ref.node.children)) {
        if (node.virtual) continue;
        if (node.relation) {
          const owner = { ref, node, targets: related(ref, node) };
          owners.push(owner);
          for (const target of owner.targets) {
            const dependencies = dependents.get(target.value) ?? [];
            dependencies.push(owner);
            dependents.set(target.value, dependencies);
          }
        } else if (node.base === 'object') {
          const v = resolveField(ref, node);
          if (isRef(v)) collect(v);
          else if (Array.isArray(v))
            v.forEach((x) => {
              if (isRef(x)) collect(x);
            });
        }
      }
    };
    for (const entity of this.model.entities)
      this.records(context, entity)
        .filter((ref) => !entity.softDelete || ref.value.deletedAt == null)
        .forEach(collect);
    const pending = [initial.value];
    for (let index = 0; index < pending.length; index++) {
      for (const { ref, node } of dependents.get(defined(pending[index], 'cascade record')) ?? []) {
        if (node.onDelete !== 'cascade' || !survives(ref)) continue;
        deleted.add(ref.value);
        pending.push(ref.value);
      }
    }
    // restrict проверяем после обхода: ссылающийся объект сам мог попасть в каскад.
    const blocked = owners.find(({ ref, targets }) => survives(ref) && targets.some((target) => deleted.has(target.value)));
    if (blocked) throw domainError('CONFLICT', `Delete restricted by ${blocked.node.path}`);
    lifecycle.deleteGroup(initial, deleted);
    const prune = (node: Node, record: JsonObject): void => {
      for (const [key, child] of Object.entries(node.children))
        if (!child.virtual && !child.relation && child.base === 'object' && record[key] != null) {
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
      const remaining = (context.data[entity.collection] ?? []).filter((record) => entity.softDelete || !deleted.has(record));
      context.data[entity.collection] = remaining;
      remaining.forEach((record) => {
        if (!deleted.has(record)) prune(entity.root, record);
      });
    }
    lifecycle.capturePruned(initial);
  }
}
