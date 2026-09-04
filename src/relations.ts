import type { DatabaseContainer } from './database.js';
import { getRelationKeys, resolveRelationResource } from './relation-metadata.js';
import type { DatabaseRecord } from './types.js';
import { createHttpError, getResourceNames, isObject, isSafeKey, singularize, toArray } from './utils.js';

interface LocalRelation {
  ids: unknown[];
  isMany: boolean;
}

interface RelationContext {
  forwardIndexes: Map<string, Map<string, DatabaseRecord>>;
  resourceNames: string[];
  reverseIndexes: Map<string, Map<string, DatabaseRecord[]>>;
}

export const createRelationContext = (database: DatabaseContainer): RelationContext => ({
  forwardIndexes: new Map(),
  resourceNames: getResourceNames(database.data),
  reverseIndexes: new Map(),
});

const findLocalRelation = (item: Record<string, unknown>, relation: string, targetResource: string): LocalRelation | undefined => {
  const relationKey = getRelationKeys(relation, singularize(relation), targetResource, singularize(targetResource)).find((key) => Object.hasOwn(item, key));

  if (relationKey == null) {
    return undefined;
  }

  return { ids: toArray(item[relationKey]).filter((id) => id != null), isMany: relationKey.endsWith('Ids') || Array.isArray(item[relationKey]) };
};

const collectReferences = (value: unknown, relationKeys: string[], references: Set<string>): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => {
      collectReferences(item, relationKeys, references);
    });
    return;
  }

  if (!isObject(value)) {
    return;
  }

  Object.entries(value).forEach(([key, nestedValue]) => {
    if (!isSafeKey(key)) {
      return;
    }

    if (relationKeys.includes(key)) {
      toArray(nestedValue).forEach((id) => {
        if (id != null) {
          references.add(String(id));
        }
      });
      return;
    }

    collectReferences(nestedValue, relationKeys, references);
  });
};

const getResourceIndex = (database: DatabaseContainer, resource: string, context: RelationContext): Map<string, DatabaseRecord> => {
  if (!context.forwardIndexes.has(resource)) {
    context.forwardIndexes.set(resource, new Map(database.data[resource].map((item) => [String(item.id), item])));
  }

  return context.forwardIndexes.get(resource) as Map<string, DatabaseRecord>;
};

const getReverseIndex = (database: DatabaseContainer, targetResource: string, relationKeys: string[], context: RelationContext): Map<string, DatabaseRecord[]> => {
  const cacheKey = `${targetResource}:${[...relationKeys].sort().join(',')}`;
  const cachedIndex = context.reverseIndexes.get(cacheKey);

  if (cachedIndex != null) {
    return cachedIndex;
  }

  const index = new Map<string, DatabaseRecord[]>();

  database.data[targetResource].forEach((item) => {
    const references = new Set<string>();

    collectReferences(item, relationKeys, references);
    references.forEach((id) => {
      index.set(id, [...(index.get(id) ?? []), item]);
    });
  });
  context.reverseIndexes.set(cacheKey, index);

  return index;
};

const findRelatedValue = (
  database: DatabaseContainer,
  item: Record<string, unknown>,
  sourceResource: string,
  relation: string,
  targetResource: string,
  context: RelationContext,
): DatabaseRecord | DatabaseRecord[] | null | undefined => {
  const localRelation = findLocalRelation(item, relation, targetResource);

  if (localRelation != null) {
    const targetIndex = getResourceIndex(database, targetResource, context);
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

  return getReverseIndex(database, targetResource, reverseRelationKeys, context).get(String(item.id)) ?? [];
};

const embedPath = (database: DatabaseContainer, item: Record<string, unknown>, sourceResource: string, relations: string[], context: RelationContext): Record<string, unknown> => {
  const [relation, ...nestedRelations] = relations;

  if (relation == null || !isSafeKey(relation)) {
    return item;
  }

  const currentValue = item[relation];
  const targetResource = resolveRelationResource(context.resourceNames, relation, sourceResource);
  const nestedSourceResource = targetResource ?? relation;
  const localRelation = targetResource == null ? undefined : findLocalRelation(item, relation, targetResource);

  if (localRelation == null) {
    if (Array.isArray(currentValue)) {
      return nestedRelations.length === 0
        ? item
        : { ...item, [relation]: currentValue.map((value) => (isObject(value) ? embedPath(database, value, nestedSourceResource, nestedRelations, context) : value)) };
    }

    if (isObject(currentValue)) {
      return nestedRelations.length === 0 ? item : { ...item, [relation]: embedPath(database, currentValue, nestedSourceResource, nestedRelations, context) };
    }
  }

  if (targetResource == null) {
    return item;
  }

  const relatedValue = findRelatedValue(database, item, sourceResource, relation, targetResource, context);

  if (relatedValue == null || nestedRelations.length === 0) {
    return relatedValue === undefined ? item : { ...item, [relation]: relatedValue };
  }

  return {
    ...item,
    [relation]: Array.isArray(relatedValue)
      ? relatedValue.map((value) => embedPath(database, value, targetResource, nestedRelations, context))
      : embedPath(database, relatedValue, targetResource, nestedRelations, context),
  };
};

export const parseEmbedPaths = (embed: unknown): string[][] => {
  if (embed == null) {
    return [];
  }

  const values = toArray(embed);

  if (values.some((value) => typeof value !== 'string')) {
    throw createHttpError(400, 'Параметр _embed должен содержать строковые пути связей');
  }

  return (values as string[])
    .flatMap((value) => value.split(','))
    .map((path) => {
      const keys = path.split('.');

      if (keys.some((key) => key === '' || !isSafeKey(key))) {
        throw createHttpError(400, `Недопустимый путь связи «${path}»`);
      }

      return keys;
    });
};

const getNestedSamples = (samples: unknown[], relation: string): Record<string, unknown>[] =>
  samples.flatMap((sample) => {
    if (!isObject(sample) || !Object.hasOwn(sample, relation)) {
      return [];
    }

    return toArray(sample[relation]).filter(isObject);
  });

const validateEmbedPath = (database: DatabaseContainer, sourceResource: string, samples: unknown[], relations: string[], path = '', resourceNames = getResourceNames(database.data)): void => {
  const [relation, ...nestedRelations] = relations;
  const relationPath = path === '' ? relation : `${path}.${relation}`;
  const targetResource = resolveRelationResource(resourceNames, relation, sourceResource);
  const nestedSamples = targetResource == null ? getNestedSamples(samples, relation) : database.data[targetResource];

  if (targetResource == null && nestedSamples.length === 0) {
    throw createHttpError(400, `Неизвестный путь связи «${relationPath}»`);
  }

  if (nestedRelations.length > 0) {
    validateEmbedPath(database, targetResource ?? relation, nestedSamples, nestedRelations, relationPath, resourceNames);
  }
};

export const validateEmbedPaths = (database: DatabaseContainer, resource: string, items: DatabaseRecord[], embedPaths: string[][]): void => {
  const resourceNames = getResourceNames(database.data);

  embedPaths.forEach((path) => {
    validateEmbedPath(database, resource, items, path, '', resourceNames);
  });
};

export const embedItem = (database: DatabaseContainer, item: DatabaseRecord, resource: string, embedPaths: string[][], context = createRelationContext(database)): DatabaseRecord =>
  embedPaths.reduce((embeddedItem, path) => embedPath(database, embeddedItem, resource, path, context) as DatabaseRecord, item);
