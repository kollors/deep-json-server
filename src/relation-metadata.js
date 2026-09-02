import { singularize } from './utils.js';

const SELF_RELATIONS = new Set(['child', 'children', 'parent', 'parents']);

export const getRelationKeys = (...names) => [...new Set(names.flatMap((name) => [`${name}Id`, `${name}Ids`]))];

export const resolveRelationResource = (resourceNames, relation, sourceResource) => {
  const resource = resourceNames.find((resourceName) => resourceName === relation) ?? resourceNames.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return SELF_RELATIONS.has(relation) && resourceNames.includes(sourceResource) ? sourceResource : undefined;
};

export const getRelationMetadata = (key, resourceNames, sourceResource) => {
  // Relation fields follow the <resource>Id and <resource>Ids conventions.
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
