import { singularize } from './utils.js';

const SELF_RELATIONS = new Set(['child', 'children', 'parent', 'parents']);

export interface RelationMetadata {
  isMany: boolean;
  relationName: string;
  reverseRelationName: string;
  sourceResource: string;
  targetResource: string;
}

/** Находит коллекцию по точному имени, единственному числу или обозначению родительской связи.
 * @example resolveRelationResource(['users'], 'user', 'posts') → 'users'.
 */
export const resolveRelationResource = (resourceNames: string[], relation: string, sourceResource: string): string | undefined => {
  const resource = resourceNames.find((resourceName) => resourceName === relation) ?? resourceNames.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return SELF_RELATIONS.has(relation) && resourceNames.includes(sourceResource) ? sourceResource : undefined;
};

/** Выводит описание связи из суффикса Id или Ids и доступных имён коллекций.
 * @example getRelationMetadata('userId', ['users', 'posts'], 'posts') → { isMany: false, relationName: 'user', reverseRelationName: 'posts', sourceResource: 'posts', targetResource: 'users' }.
 */
export const getRelationMetadata = (key: string, resourceNames: string[], sourceResource: string): RelationMetadata | undefined => {
  // Суффиксы Id и Ids обозначают одиночный ключ и массив ключей.
  const match = key.match(/^(.+)(Id|Ids)$/);

  if (match == null) {
    return undefined;
  }

  const [, relation, suffix] = match;
  const isMany = suffix === 'Ids';
  const relationName = isMany ? (resourceNames.find((resource) => singularize(resource) === relation) ?? `${relation}s`) : relation;
  const targetResource = resolveRelationResource(resourceNames, relationName, sourceResource);

  if (targetResource == null) {
    return undefined;
  }

  return {
    isMany,
    relationName,
    reverseRelationName: ['parent', 'parents'].includes(relationName) ? 'children' : sourceResource,
    sourceResource,
    targetResource,
  };
};
