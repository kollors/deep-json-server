import { domainError } from '../errors.js';
import { DELETION_META, type RecordOptions } from '../lifecycle/options.js';
import { defined, isObject, isSafeKey } from '../utils.js';
import type { Entity, Field, Model, Node, RelationNode } from './types.js';
export const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
/** Разбивает путь по точкам и проверяет допустимость каждого имени.
 * @example pathParts('profile.name') → ['profile', 'name']; pathParts('a..b') → ошибка.
 */
export const pathParts = (path: string): string[] => {
  const parts = path.split('.');
  if (parts.some((p) => !NAME.test(p) || !isSafeKey(p))) throw domainError('INVALID_INPUT', `Invalid field path: ${path}`);
  return parts;
};
/** Находит самый длинный префикс пути среди ключей объекта, учитывая границы сегментов.
 * @example bindingFor({ a: {}, 'a.b': {} }, 'a.b.id') → 'a.b'; bindingFor({ a: {} }, 'abc.id') → undefined.
 */
export function bindingFor(bindings: Record<string, unknown>, path: string): string | undefined {
  let nearest: string | undefined;
  for (const prefix of Object.keys(bindings)) if ((path === prefix || path.startsWith(`${prefix}.`)) && (!nearest || prefix.length > nearest.length)) nearest = prefix;
  return nearest;
}
/** Проверяет, что все сегменты пути объявлены и доступны для записи, включая родительские объекты.
 * @example Для поля name без ограничений canWriteKey(entity, 'name') → true; для первичного ключа → false.
 */
export function canWriteKey(entity: Entity, path: string): boolean {
  const parts = pathParts(path);
  return parts.every((_, index) => {
    const field = entity.fields[parts.slice(0, index + 1).join('.')];
    return field && !field.primary && !field.generated && !field.readOnly;
  });
}
/** Выбирает обратную запись, если источник первичный; иначе — если источник защищён, а целевой ключ изменяемый.
 * @example При source = 'id', target = 'authorId' и первичных ключах id → true.
 */
export function isReverseRelation(entity: Entity, node: Node): boolean {
  const relation = requireRelation(node);
  if (relation.keyOn) return relation.keyOn === 'related';
  return relation.source === entity.primary || (!canWriteKey(entity, relation.source) && canWriteKey(relation.relation, relation.target));
}
/** Собирает значения по вложенному пути, проходя через массивы; отсутствующие значения и null пропускает.
 * @example readPath({ rows: [{ id: 1 }, { id: 2 }] }, 'rows.id') → [1, 2].
 */
export const readPath = (value: unknown, path: string | string[]): unknown[] => {
  const parts = typeof path === 'string' ? pathParts(path) : path;
  const [head, ...tail] = parts;
  if (head === undefined) return Array.isArray(value) ? value.flatMap((v) => readPath(v, [])) : value == null ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((v) => readPath(v, parts));
  return isObject(value) && Object.hasOwn(value, head) ? readPath(value[head], tail) : [];
};
/** Возвращает последний сегмент пути поля.
 * @example childName({ path: 'profile.name', … }) → 'name'.
 */
export const childName = (node: Node): string => node.path.slice(node.path.lastIndexOf('.') + 1);
/** Для связи возвращает целевую сущность и её корень; обычный узел сохраняет без изменений.
 * @example canonicalNode(author, { relation: book }) → [book, book.root].
 * @example canonicalNode(author, author.root) → [author, author.root].
 */
export const canonicalNode = (entity: Entity, node: Node): [Entity, Node] => (node.relation ? [node.relation, node.relation.root] : [entity, node]);
/** Соединяет имя сущности и путь поля, заменяя точки подчёркиваниями.
 * @example nodeName({ name: 'User', … }, { path: 'profile.name', … }) → 'User_profile_name'.
 */
export const nodeName = (entity: Entity, node: Node): string => (node.path ? `${entity.name}_${node.path.replaceAll('.', '_')}` : entity.name);
/** Переводит первую букву имени сущности в нижний регистр.
 * @example operationName({ name: 'UserProfile', … }) → 'userProfile'.
 */
export const operationName = (entity: Entity): string => entity.name.charAt(0).toLowerCase() + entity.name.slice(1);
/** Создаёт узел с разобранным типом и пустым словарём дочерних полей.
 * @example newNode('tags', { type: 'string[]' }) → узел с base: 'string', many: true.
 */
export const newNode = (path: string, field: Field): Node => ({ ...field, path, base: field.type.replace(/\[\]$/, ''), many: field.type.endsWith('[]'), children: Object.create(null) });
/** Добавляет поле по пути, создавая промежуточные объекты и сохраняя уже объявленных детей.
 * @example Путь 'profile.name' и type: 'string' → узлы profile и profile.name в дереве.
 */
export function addField(entity: Entity, path: string, field: Field, implicit = false): Node {
  const parts = pathParts(path);
  let parent = entity.root;
  for (let i = 0; i < parts.length - 1; i++) {
    const prefix = parts.slice(0, i + 1).join('.');
    const part = defined(parts[i], 'field path segment');
    const child = parent.children[part] ?? newNode(prefix, { type: 'object' });
    parent.children[part] = child;
    entity.fields[prefix] = child;
    parent = child;
    if (parent.base !== 'object') throw new Error(`Field ${entity.name}.${prefix} cannot contain fields`);
  }
  const key = defined(parts.at(-1), 'field path');
  const node = newNode(path, field);
  node.implicit = implicit;
  node.children = parent.children[key]?.children ?? Object.create(null);
  parent.children[key] = node;
  entity.fields[path] = node;
  return node;
}
/** Помечает непервичные поля, в которых хранятся ключи связей.
 * @example Для связи user с source = 'userId' поле userId получает relationKey = true, а первичный id остаётся обычным полем.
 */
export function markRelationKeys(model: Model): void {
  for (const entity of model.entities)
    for (const node of Object.values(entity.fields)) {
      if (!node.relation) continue;
      const sourceField = entity.fields[node.source];
      const targetField = node.relation.fields[node.target];
      if (sourceField && !sourceField.primary) sourceField.relationKey = true;
      if (targetField && !targetField.primary) targetField.relationKey = true;
    }
}
/** Добавляет защищённые поля дат, авторов и прав согласно настройкам сущности.
 * @example timestamps: true → поля createdAt и updatedAt; занятое имя → ошибка.
 */
export function systemFields(entity: Entity, options: Required<RecordOptions>): void {
  const names = [
    ...(entity.timestamps ? ['createdAt', 'updatedAt'] : []),
    DELETION_META,
    ...(entity.softDelete ? ['deletedAt'] : []),
    ...(options.auth ? ['createdById', 'updatedById', ...(entity.softDelete ? ['deletedById'] : [])] : []),
  ];
  entity.root.softDelete = entity.softDelete;
  for (const name of names) {
    if (entity.fields[name]) throw new Error(`Reserved system field ${entity.name}.${name}`);
    const node = addField(entity, name, { type: 'string', readOnly: true, nullable: true, ...(name.endsWith('At') ? { format: 'date-time' } : {}) });
    node.system = true;
    if (name === DELETION_META) {
      node.internal = true;
      node.writeOnly = true;
    }
  }
  if (options.auth) {
    if (entity.fields.actions) throw new Error(`Reserved system field ${entity.name}.actions`);
    const actions = addField(entity, 'actions', { type: 'object', required: true, readOnly: true });
    actions.system = true;
    actions.virtual = 'actions';
    for (const name of ['update', 'replace', 'delete']) addField(entity, `actions.${name}`, { type: 'boolean', required: true, readOnly: true });
  }
}

/** Возвращает объявленное поле или сообщает о нарушенной структуре модели.
 * @example Поле id существует → его узел; отсутствует → ошибка с именем поля.
 */
export function fieldAt(entity: Entity, path: string): Node {
  const node = entity.fields[path];
  if (!node) throw new Error(`Unknown field ${entity.name}.${path}`);
  return node;
}
/** Проверяет, что узел содержит подготовленную связь с обоими путями ключей.
 * @example Узел user с relation, source и target → тот же узел; скаляр → ошибка.
 */
export function requireRelation(node: Node): RelationNode {
  if (!node.relation) throw new Error(`Expected relation at ${node.path}`);
  return node;
}
/** Привязывает узел к целевой сущности, сохраняя ссылки из дерева полей.
 * @example source = 'userId', target = 'id' → узел с обязательными путями связи.
 */
export function linkRelation(node: Node, relation: Entity, source: string, target: string): RelationNode {
  return Object.assign(node, { relation, source, target });
}
