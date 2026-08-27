import { getResourceNames, isEqual, isObject, isSafeKey, singularize, toArray } from './utils.js';

const resolveResource = (database, relation, sourceResource) => {
  const resourceNames = getResourceNames(database.data);
  const resource = resourceNames.find((resourceName) => resourceName === relation) ?? resourceNames.find((resourceName) => singularize(resourceName) === relation);

  if (resource != null) {
    return resource;
  }

  return ['child', 'children', 'parent', 'parents'].includes(relation) && resourceNames.includes(sourceResource) ? sourceResource : undefined;
};

const getRelationKeys = (...names) => [...new Set(names.flatMap((name) => [`${name}Id`, `${name}Ids`]))];

const findLocalRelation = (item, relation, targetResource) => {
  const relationKey = getRelationKeys(relation, singularize(relation), targetResource, singularize(targetResource)).find((key) => Object.hasOwn(item, key));

  if (relationKey == null) {
    return undefined;
  }

  return { ids: toArray(item[relationKey]).filter((id) => id != null), isMany: relationKey.endsWith('Ids') || Array.isArray(item[relationKey]) };
};

const hasReference = (value, relationKeys, id) => {
  if (Array.isArray(value)) {
    return value.some((item) => hasReference(item, relationKeys, id));
  }

  if (!isObject(value)) {
    return false;
  }

  return Object.entries(value).some(([key, nestedValue]) => {
    if (!isSafeKey(key)) {
      return false;
    }

    if (relationKeys.includes(key)) {
      return toArray(nestedValue).some((nestedId) => isEqual(nestedId, id));
    }

    return hasReference(nestedValue, relationKeys, id);
  });
};

const getResourceIndex = (database, resource, indexes) => {
  if (!indexes.has(resource)) {
    const index = new Map();

    database.data[resource].forEach((item) => {
      if (isObject(item) && item.id != null && !index.has(item.id)) {
        index.set(item.id, item);
      }
    });

    indexes.set(resource, index);
  }

  return indexes.get(resource);
};

const findRelatedValue = (database, item, sourceResource, relation, targetResource, indexes) => {
  const targetItems = database.data[targetResource];
  const localRelation = findLocalRelation(item, relation, targetResource);

  if (!Array.isArray(targetItems)) {
    return undefined;
  }

  if (localRelation != null) {
    const targetIndex = getResourceIndex(database, targetResource, indexes);
    const relatedItems = localRelation.ids.map((id) => targetIndex.get(id)).filter((targetItem) => targetItem != null);

    return localRelation.isMany ? relatedItems : relatedItems[0] ?? null;
  }

  if (item.id == null) {
    return undefined;
  }

  const reverseRelationKeys = getRelationKeys(singularize(sourceResource));

  if (relation === 'child' || relation === 'children') {
    reverseRelationKeys.push('parentId', 'parentIds');
  }

  return targetItems.filter((targetItem) => hasReference(targetItem, reverseRelationKeys, item.id));
};

const embedPath = (database, item, sourceResource, [relation, ...nestedRelations], indexes) => {
  if (relation == null || !isSafeKey(relation)) {
    return item;
  }

  const currentValue = item[relation];
  const targetResource = resolveResource(database, relation, sourceResource);
  const nestedSourceResource = targetResource ?? relation;
  const localRelation = targetResource == null ? undefined : findLocalRelation(item, relation, targetResource);

  if (localRelation == null) {
    if (Array.isArray(currentValue)) {
      return nestedRelations.length === 0 ? item : { ...item, [relation]: currentValue.map((value) => (isObject(value) ? embedPath(database, value, nestedSourceResource, nestedRelations, indexes) : value)) };
    }

    if (isObject(currentValue)) {
      return nestedRelations.length === 0 ? item : { ...item, [relation]: embedPath(database, currentValue, nestedSourceResource, nestedRelations, indexes) };
    }
  }

  if (targetResource == null) {
    return item;
  }

  const relatedValue = findRelatedValue(database, item, sourceResource, relation, targetResource, indexes);

  if (relatedValue == null || nestedRelations.length === 0) {
    return relatedValue === undefined ? item : { ...item, [relation]: relatedValue };
  }

  return {
    ...item,
    [relation]: Array.isArray(relatedValue)
      ? relatedValue.map((value) => embedPath(database, value, targetResource, nestedRelations, indexes))
      : embedPath(database, relatedValue, targetResource, nestedRelations, indexes),
  };
};

export const parseEmbedPaths = (embed) => toArray(embed)
  .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
  .map((path) => path.split('.').filter(Boolean))
  .filter((path) => path.length > 0 && path.every(isSafeKey));

export const embedItem = (database, item, resource, embedPaths, indexes = new Map()) => embedPaths.reduce((embeddedItem, path) => embedPath(database, embeddedItem, resource, path, indexes), item);
