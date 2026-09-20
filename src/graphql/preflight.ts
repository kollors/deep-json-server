import {
  type FieldNode,
  GraphQLIncludeDirective,
  type GraphQLObjectType,
  type GraphQLResolveInfo,
  GraphQLSkipDirective,
  getArgumentValues,
  getDirectiveValues,
  getNamedType,
  isObjectType,
  type SelectionSetNode,
} from 'graphql';
import type { Engine, PreparedList } from '../core/engine.js';
import type { Node } from '../core/model.js';
import { defined } from '../core/utils.js';
/** Обходит выбранные поля, фрагменты и директивы и подготавливает аргументы списков до изменения данных.
 * @example Запрос без списков → пустая Map; выбранный список с pageSize: 0 → ошибка.
 */
export function preflight(info: GraphQLResolveInfo, engine: Engine): Map<FieldNode, PreparedList> {
  const prepared = new Map<FieldNode, PreparedList>();
  const root = info.operation.operation === 'mutation' ? info.schema.getMutationType() : info.schema.getQueryType();
  if (!root) throw new Error('GraphQL operation root is unavailable');
  const visited = new Map<SelectionSetNode, Set<GraphQLObjectType<unknown, unknown>>>();
  const walk = (selectionSet: SelectionSetNode, parent: GraphQLObjectType<unknown, unknown>): void => {
    let parents = visited.get(selectionSet);
    if (!parents) {
      parents = new Set<GraphQLObjectType<unknown, unknown>>();
      visited.set(selectionSet, parents);
    }
    if (parents.has(parent)) return;
    parents.add(parent);
    for (const selection of selectionSet.selections) {
      if (getDirectiveValues(GraphQLSkipDirective, selection, info.variableValues)?.if === true || getDirectiveValues(GraphQLIncludeDirective, selection, info.variableValues)?.if === false) continue;
      if (selection.kind === 'FragmentSpread') {
        walk(defined(info.fragments[selection.name.value], 'GraphQL fragment').selectionSet, parent);
        continue;
      }
      if (selection.kind === 'InlineFragment') {
        walk(selection.selectionSet, parent);
        continue;
      }
      const field = parent.getFields()[selection.name.value];
      if (!field) continue;
      if (field.extensions.listNode && !prepared.has(selection))
        prepared.set(selection, engine.prepareOptions(field.extensions.listNode as Node, getArgumentValues(field, selection, info.variableValues)));
      const type = getNamedType(field.type);
      if (selection.selectionSet && isObjectType(type)) walk(selection.selectionSet, type);
    }
  };
  walk(info.operation.selectionSet, root);
  return prepared;
}
