import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { domainError } from '../errors.js';
import { AUDIT_FIELDS } from '../lifecycle/options.js';
import { defined } from '../utils.js';
import { type InputMode, requiredInput, writable } from './policy.js';
import type { Entity, Node, ValidationSchema } from './types.js';
/** Создаёт независимый валидатор JSON Schema с форматами и строгой проверкой без преобразования данных.
 * @example createValidator().validate({ type: 'number' }, '1') → false.
 */
export const createValidator = () => {
  const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, strict: true, ownProperties: true });
  addFormats.default(ajv);
  return ajv;
};
export const entityValidators = new WeakMap<Entity, Ajv>();
/** Строит схему проверки значения с ограничениями, массивом и допустимостью null.
 * @example Для строкового узла без ограничений valueSchema(node) → { type: 'string' }.
 */
export function valueSchema(node: Node): ValidationSchema {
  if (node.base !== 'string' && node.base !== 'number' && node.base !== 'boolean' && node.base !== 'object') throw new Error(`Invalid value type ${node.base}`);
  let schema: ValidationSchema = node.base === 'object' ? objectSchema(node, 'stored') : { type: node.base };
  for (const key of ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'enum'] as const) if (node[key] !== undefined) Object.assign(schema, { [key]: node[key] });
  if (node.many) schema = { type: 'array', items: schema };
  if (node.nullable) schema = { anyOf: [schema, { type: 'null' }] };
  return schema;
}
/** Строит схему объекта для выбранного режима; при частичном обновлении корневые поля необязательны.
 * @example Для пустого узла → { type: 'object', properties: {}, additionalProperties: false }.
 */
export function objectSchema(node: Node, mode: InputMode, root = false, relationSchema?: (node: Node) => ValidationSchema): ValidationSchema {
  const properties: Record<string, ValidationSchema> = {};
  const required: string[] = [];
  for (const [key, child] of Object.entries(node.children)) {
    if (child.virtual) continue;
    if (child.relation) {
      if (mode !== 'stored' && relationSchema) properties[key] = relationSchema(child);
      continue;
    }
    if (mode !== 'stored' && !writable(child, mode, !!relationSchema)) continue;
    properties[key] =
      child.base === 'object'
        ? (() => {
            let s: ValidationSchema = objectSchema(child, mode, false, relationSchema);
            if (child.many) s = { type: 'array', items: s };
            return child.nullable ? { anyOf: [s, { type: 'null' }] } : s;
          })()
        : valueSchema(child);
    if (requiredInput(child, mode, root, !!relationSchema)) required.push(key);
  }
  // Сохраняем ранее записанные даты и авторов при отключении соответствующих флагов.
  if (root && mode === 'stored') for (const name of AUDIT_FIELDS) properties[name] ??= { type: ['string', 'null'], ...(name.endsWith('At') ? { format: 'date-time' } : {}) };
  return { type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) };
}
/** Описывает ввод связанной записи: объект, при необходимости — массив объектов.
 * @example Связь со строковым ключом → объект; many: true → массив объектов.
 */
export function relationInputSchema(node: Node, object: ValidationSchema = { type: 'object' }): ValidationSchema {
  let schema: ValidationSchema = object;
  if (node.many) schema = { type: 'array', items: schema };
  else if (node.nullable) schema = { anyOf: [schema, { type: 'null' }] };
  return schema;
}
const validators = new WeakMap<Entity, Map<string, ValidateFunction>>();
/** Проверяет запись по схеме выбранного режима и выбрасывает исключение при несоответствии.
 * @example Обязательное строковое name: { name: 'Анна' } → undefined; { name: 2 } → ошибка.
 */
export function validateRecord(entity: Entity, value: unknown, mode: InputMode, relations = false): void {
  const ajv = defined(entityValidators.get(entity), `validator for ${entity.name}`);
  let cache = validators.get(entity);
  if (!cache) {
    cache = new Map();
    validators.set(entity, cache);
  }
  const key = `${mode}:${relations}`;
  let validate = cache.get(key);
  if (!validate) {
    validate = ajv.compile(objectSchema(entity.root, mode, true, relations ? (node) => relationInputSchema(node) : undefined));
    cache.set(key, validate);
  }
  if (!validate(value)) throw domainError('INVALID_INPUT', `${entity.name}: ${ajv.errorsText(validate.errors)}`);
}
