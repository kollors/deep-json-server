import {
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
import type { Engine } from '../engine.js';
import type { Node } from '../model.js';
export function preflight(info: GraphQLResolveInfo, engine: Engine): void {
  const root = info.operation.operation === 'mutation' ? info.schema.getMutationType()! : info.schema.getQueryType()!;
  const walk = (selectionSet: SelectionSetNode, parent: GraphQLObjectType): void => {
    for (const selection of selectionSet.selections) {
      if (getDirectiveValues(GraphQLSkipDirective, selection, info.variableValues)?.if === true || getDirectiveValues(GraphQLIncludeDirective, selection, info.variableValues)?.if === false) continue;
      if (selection.kind === 'FragmentSpread') {
        walk(info.fragments[selection.name.value].selectionSet, parent);
        continue;
      }
      if (selection.kind === 'InlineFragment') {
        walk(selection.selectionSet, parent);
        continue;
      }
      const field = parent.getFields()[selection.name.value];
      if (!field) continue;
      if (field.extensions.listNode) engine.validateOptions(field.extensions.listNode as Node, getArgumentValues(field, selection, info.variableValues));
      const type = getNamedType(field.type);
      if (selection.selectionSet && isObjectType(type)) walk(selection.selectionSet, type);
    }
  };
  walk(info.operation.selectionSet, root);
}
