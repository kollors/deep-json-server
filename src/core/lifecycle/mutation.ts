import { randomUUID } from 'node:crypto';
import { domainError } from '../errors.js';
import type { Entity, Model } from '../model.js';
import { cloneSnapshot } from '../snapshot.js';
import type { DatabaseData, DatabaseSnapshot, JsonObject, JsonValue, RecordSnapshot } from '../types.js';
import { defined, isEqual, isObject, isSafeKey } from '../utils.js';
import { type Actor, canChangeRecord, DELETION_META } from './options.js';

interface Patch {
  collection: string;
  key: JsonValue;
  field: string;
  before: JsonValue;
  after?: JsonValue;
}
interface Deletion {
  id: string;
  root: boolean;
  patches?: Patch[];
}
const keyOf = (entity: Entity, record: RecordSnapshot) => JSON.stringify([entity.collection, String(record[entity.primary])]);

/** Проверяет владельцев и заполняет поля дат и авторов внутри транзакции. */
export class RecordMutation {
  readonly now = new Date().toISOString();
  private originals = new Map<string, RecordSnapshot>();
  private touched = new Set<string>();
  private enabled: boolean;
  constructor(
    private data: DatabaseData,
    private model: Model,
    private actor: Actor | undefined,
    readonly before: DatabaseSnapshot,
  ) {
    if (model.options.auth && !actor) throw domainError('UNAUTHENTICATED', 'Authentication required');
    this.enabled = model.options.auth || model.entities.some((entity) => entity.timestamps || entity.softDelete);
    if (!this.enabled) return;
    for (const entity of model.entities) for (const record of this.before[entity.collection] ?? []) this.originals.set(keyOf(entity, record), record);
  }
  /** Проверяет владельца исходной записи или права администратора; данные не меняет.
   * @example Совпадающие createdById и actor.id → undefined; чужая запись без прав администратора → FORBIDDEN.
   */
  check(entity: Entity, record: RecordSnapshot): void {
    const original = this.originals.get(keyOf(entity, record));
    if (this.model.options.auth && original && !canChangeRecord(this.actor, original)) throw domainError('FORBIDDEN', 'Only the owner or an administrator can change this record');
  }
  /** Отмечает запись изменённой и при необходимости восстанавливает её каскад в черновике.
   * @example Удалённая запись после успешного вызова → deletedAt: null; конфликт восстановления → ошибка.
   */
  write(entity: Entity, record: JsonObject): void {
    if (!this.enabled) return;
    this.check(entity, record);
    this.touched.add(keyOf(entity, record));
    if (!entity.softDelete || record.deletedAt == null) return;
    const deletion = this.deletion(record);
    if (deletion?.root) {
      for (const owner of this.model.entities)
        for (const row of this.data[owner.collection] ?? []) {
          if (!owner.softDelete || row.deletedAt == null || this.deletion(row)?.id !== deletion.id) continue;
          this.check(owner, row);
          this.clear(owner, row);
        }
      for (const patch of deletion.patches ?? []) {
        const owner = this.model.byCollection.get(patch.collection);
        const row = owner && (this.data[owner.collection] ?? []).find((value) => String(value[owner.primary]) === String(patch.key));
        if (!owner || !row || row.deletedAt != null || !isEqual(row[patch.field], patch.after)) throw domainError('CONFLICT', 'A cascaded object changed after deletion');
        this.check(owner, row);
        row[patch.field] = structuredClone(patch.before);
        this.touched.add(keyOf(owner, row));
      }
    }
    this.clear(entity, record);
  }
  /** Очищает признаки удаления и служебные сведения восстановления, отмечая запись изменённой.
   * @example Запись с deletedAt и сведениями каскада → deletedAt: null без служебных сведений; результат undefined.
   */
  private clear(entity: Entity, record: JsonObject): void {
    record.deletedAt = null;
    if (this.model.options.auth) record.deletedById = null;
    delete record[DELETION_META];
    this.touched.add(keyOf(entity, record));
  }
  /** Помечает выбранные записи временем удаления и общим случайным идентификатором операции.
   * @example Две записи с включённым мягким удалением → одинаковые дата и идентификатор каскада.
   */
  deleteGroup(initial: { entity: Entity; value: JsonObject }, deleted: Set<JsonObject>): void {
    const id = randomUUID();
    for (const entity of this.model.entities)
      for (const record of this.data[entity.collection] ?? []) {
        if (!deleted.has(record) || !entity.softDelete) continue;
        this.check(entity, record);
        record.deletedAt = this.now;
        if (this.model.options.auth) record.deletedById = this.actor?.id ?? null;
        record[DELETION_META] = JSON.stringify({ id, root: record === initial.value });
      }
  }
  /** Сохраняет изменения вложенных объектов для последующего восстановления каскада.
   * @example Поле actors изменилось с [a, b] на [b] → в сведениях удаления сохранены оба состояния.
   */
  capturePruned(initial: { entity: Entity; value: JsonObject }): void {
    if (!initial.entity.softDelete) return;
    const patches: Patch[] = [];
    for (const entity of this.model.entities)
      for (const row of this.data[entity.collection] ?? []) {
        const old = this.originals.get(keyOf(entity, row));
        if (!old || row.deletedAt != null) continue;
        for (const [field, node] of Object.entries(entity.root.children)) {
          if (node.virtual || node.relation || node.base !== 'object' || !Object.hasOwn(old, field) || isEqual(old[field], row[field])) continue;
          patches.push({
            collection: entity.collection,
            key: defined(row[entity.primary], entity.primary),
            field,
            before: cloneSnapshot(defined(old[field], field)),
            ...(row[field] !== undefined ? { after: structuredClone(row[field]) } : {}),
          });
        }
      }
    const deletion = this.deletion(initial.value) as Deletion;
    initial.value[DELETION_META] = JSON.stringify({ ...deletion, patches });
  }
  /** Проверяет права на все изменения и проставляет даты и авторов в черновике.
   * @example Новая запись при включённых флагах → createdAt = updatedAt и createdById = updatedById.
   */
  finish(): void {
    if (!this.enabled) return;
    for (const entity of this.model.entities) {
      const present = new Set<string>();
      for (const record of this.data[entity.collection] ?? []) {
        const key = keyOf(entity, record);
        present.add(key);
        const original = this.originals.get(key);
        if (original && !this.touched.has(key) && isEqual(original, record)) continue;
        this.check(entity, record);
        for (const [name, field] of Object.entries(entity.root.children)) if (field.system && !field.internal && !field.virtual && !Object.hasOwn(record, name)) record[name] = null;
        if (entity.timestamps) {
          record.createdAt = cloneSnapshot(original?.createdAt ?? (original ? null : this.now));
          record.updatedAt = this.now;
        }
        if (this.model.options.auth) {
          record.createdById = cloneSnapshot(original?.createdById ?? (original ? null : (this.actor?.id ?? null)));
          record.updatedById = this.actor?.id ?? null;
        }
      }
      for (const old of this.before[entity.collection] ?? []) if (!present.has(keyOf(entity, old))) this.check(entity, old);
    }
  }
  /** Разбирает и проверяет внутреннюю JSON-строку сведений об удалении.
   * @example Отсутствующие сведения → undefined; корректная строка → объект; повреждённая строка → ошибка.
   */
  private deletion(record: JsonObject): Deletion | undefined {
    const raw = record[DELETION_META];
    if (raw == null) return undefined;
    try {
      const value: unknown = JSON.parse(typeof raw === 'string' ? raw : '');
      if (!isObject(value) || typeof value.id !== 'string' || typeof value.root !== 'boolean') throw new Error();
      let patches: Patch[] | undefined;
      if (value.patches !== undefined) {
        if (!Array.isArray(value.patches)) throw new Error();
        patches = value.patches.map((patch: unknown): Patch => {
          if (
            !isObject(patch) ||
            typeof patch.collection !== 'string' ||
            typeof patch.field !== 'string' ||
            !isSafeKey(patch.field) ||
            !['string', 'number'].includes(typeof patch.key) ||
            !Object.hasOwn(patch, 'before')
          )
            throw new Error();
          // После JSON.parse каждое значение уже принадлежит JSON; проверяем отсутствующие поля отдельно.
          return {
            collection: patch.collection,
            key: patch.key as string | number,
            field: patch.field,
            before: patch.before as JsonValue,
            ...(Object.hasOwn(patch, 'after') ? { after: patch.after as JsonValue } : {}),
          };
        });
      }
      return { id: value.id, root: value.root, ...(patches ? { patches } : {}) };
    } catch {
      throw domainError('INVALID_INPUT', 'Invalid deletion metadata');
    }
  }
}
