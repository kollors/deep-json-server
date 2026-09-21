import type { WriteMode } from '../operations.js';
import type { Model, Node } from './types.js';
export type InputMode = 'stored' | WriteMode;
/** Определяет доступность поля для выбранного режима записи, учитывая защищённые дочерние поля.
 * @example writable({ readOnly: true, … }, 'update') → false.
 */
export function writable(node: Node, mode: InputMode, relations = false): boolean {
  if (node.relation) return relations;
  if (node.generated || node.readOnly || (node.primary && mode !== 'create')) return false;
  const children = Object.values(node.children);
  return node.base !== 'object' || children.length === 0 || children.some((child) => writable(child, mode, relations));
}
/** Проверяет наличие явной модели и доступность выбранного формата для её связей.
 * @example assertApi(undefined, 'graphql') → ошибка; согласованная модель → undefined.
 */
export function assertApi(model: Model | undefined, api: 'graphql' | 'openapi'): asserts model is Model {
  if (!model?.explicit) throw new Error(`${api} requires an explicit model schema`);
  if (!model.entities.some((entity) => entity.api.includes(api))) throw new Error(`No models enable ${api}`);
  for (const entity of model.entities.filter((e) => e.api.includes(api)))
    for (const node of Object.values(entity.fields))
      if (node.relation && !node.relation.api.includes(api)) throw new Error(`${entity.name}.${node.path}: ${node.relation.name} does not enable ${api}`);
}
/** Определяет обязательность поля в теле операции, независимо от формата API.
 * @example Обязательное поле без default: create → true; корневое update → false.
 */
export function requiredInput(node: Node, mode: InputMode, root = false, relations = false): boolean {
  return !!node.required && !(root && mode === 'update') && !(mode !== 'stored' && node.default !== undefined) && !(relations && node.relationKey);
}
