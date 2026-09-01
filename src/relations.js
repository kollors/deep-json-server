import { getRelationKeys, resolveRelationResource } from './relation-metadata.js';
import { createHttpError, getResourceNames, isIdEqual, isObject, isSafeKey, singularize, toArray } from './utils.js';

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
      return toArray(nestedValue).some((nestedId) => isIdEqual(nestedId, id));
    }

    return hasReference(nestedValue, relationKeys, id);
  });
};

const getResourceIndex = (database, resource, indexes) => {
  if (!indexes.has(resource)) {
    const index = new Map();

    database.data[resource].forEach((item) => {
      if (isObject(item) && item.id != null && !index.has(item.id)) {
        index.set(String(item.id), item);
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
    const relatedItems = localRelation.ids.map((id) => targetIndex.get(String(id))).filter((targetItem) => targetItem != null);

    return localRelation.isMany ? relatedItems : (relatedItems[0] ?? null);
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
  const targetResource = resolveRelationResource(getResourceNames(database.data), relation, sourceResource);
  const nestedSourceResource = targetResource ?? relation;
  const localRelation = targetResource == null ? undefined : findLocalRelation(item, relation, targetResource);

  if (localRelation == null) {
    if (Array.isArray(currentValue)) {
      return nestedRelations.length === 0
        ? item
        : { ...item, [relation]: currentValue.map((value) => (isObject(value) ? embedPath(database, value, nestedSourceResource, nestedRelations, indexes) : value)) };
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

export const parseEmbedPaths = (embed) => {
  if (embed == null) {
    return [];
  }

  const values = toArray(embed);

  if (values.some((value) => typeof value !== 'string')) {
    throw createHttpError(400, 'Параметр _embed должен содержать строковые пути связей');
  }

  return values
    .flatMap((value) => value.split(','))
    .map((path) => {
      const keys = path.split('.');

      if (keys.some((key) => key === '' || !isSafeKey(key))) {
        throw createHttpError(400, `Недопустимый путь связи «${path}»`);
      }

      return keys;
    });
};

const getNestedSamples = (samples, relation) =>
  samples.flatMap((sample) => {
    if (!isObject(sample) || !Object.hasOwn(sample, relation)) {
      return [];
    }

    return toArray(sample[relation]).filter(isObject);
  });

const validateEmbedPath = (database, sourceResource, samples, [relation, ...nestedRelations], path = '') => {
  const relationPath = path === '' ? relation : `${path}.${relation}`;
  const targetResource = resolveRelationResource(getResourceNames(database.data), relation, sourceResource);
  const nestedSamples = targetResource == null ? getNestedSamples(samples, relation) : database.data[targetResource];

  if (targetResource == null && nestedSamples.length === 0) {
    throw createHttpError(400, `Неизвестный путь связи «${relationPath}»`);
  }

  if (nestedRelations.length > 0) {
    validateEmbedPath(database, targetResource ?? relation, nestedSamples, nestedRelations, relationPath);
  }
};

export const validateEmbedPaths = (database, resource, items, embedPaths) => {
  embedPaths.forEach((path) => {
    validateEmbedPath(database, resource, items, path);
  });
};

export const embedItem = (database, item, resource, embedPaths, indexes = new Map()) => embedPaths.reduce((embeddedItem, path) => embedPath(database, embeddedItem, resource, path, indexes), item);
