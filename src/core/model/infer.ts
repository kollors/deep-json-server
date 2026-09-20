import { type RecordOptions, recordOptions } from '../lifecycle/options.js';
import { getRelationMetadata } from '../relation-metadata.js';
import type { DatabaseSnapshot } from '../types.js';
import { defined, isObject, isSafeKey, singularize, toPascalCase } from '../utils.js';
import { addField, childName, linkRelation, markRelationKeys, NAME, newNode, systemFields } from './tree.js';
import type { Entity, Model } from './types.js';
/** Выводит поля и связи из значений коллекций, не меняя переданные записи.
 * @example inferModel({ users: [{ id: '1', name: 'Анна' }] }) → модель со строковыми id и name.
 */
export function inferModel(database: DatabaseSnapshot, settings: RecordOptions = {}): Model {
  const options = recordOptions(settings);
  const valueType = (value: unknown) => (isObject(value) ? 'object' : ['string', 'number', 'boolean'].includes(typeof value) ? typeof value : 'string');
  const model: Model = { entities: [], byName: new Map(), byCollection: new Map(), explicit: false, options };
  for (const [collection, records] of Object.entries(database)) {
    const name = toPascalCase(singularize(collection));
    const entity: Entity = {
      timestamps: options.timestamps,
      softDelete: options.softDelete,
      name,
      collection,
      api: [],
      primary: 'id',
      fields: Object.create(null),
      root: newNode('', { type: 'object' }),
    };
    systemFields(entity, options);
    const observed = new Map<string, Set<string>>();
    const scan = (record: Record<string, unknown>, prefix = '') => {
      for (const [key, value] of Object.entries(record)) {
        if (!NAME.test(key) || !isSafeKey(key) || (!prefix && entity.fields[key]?.system)) continue;
        const path = prefix + key;
        const sample = Array.isArray(value) ? value.find((v) => v !== null) : value;
        const base = valueType(sample);
        const type = base + (Array.isArray(value) ? '[]' : '');
        const types = observed.get(path) ?? new Set<string>();
        for (const element of Array.isArray(value) ? value : [value]) {
          if (element == null) continue;
          types.add(valueType(element) + (Array.isArray(value) ? '[]' : ''));
        }
        observed.set(path, types);
        const node = entity.fields[path] ?? addField(entity, path, { type });
        if (types.size) {
          node.mixed = node.mixed || types.size > 1 || (Array.isArray(value) && value.some(isObject) && value.some((item) => !isObject(item)));
          node.base = [...types].some((type) => type.startsWith('object')) ? 'object' : defined([...types].sort()[0], 'observed field type').replace(/\[\]$/, '');
          node.many = [...types].every((type) => type.endsWith('[]'));
          node.type = node.base + (node.many ? '[]' : '');
        }
        if (isObject(value)) scan(value, `${path}.`);
        if (Array.isArray(value))
          value.filter(isObject).forEach((v) => {
            scan(v, `${path}.`);
          });
      }
    };
    records.forEach((scanRecord) => {
      scan(scanRecord);
    });
    const id = entity.fields.id ?? addField(entity, 'id', { type: 'string' });
    id.primary = true;
    model.entities.push(entity);
    model.byCollection.set(collection, entity);
    model.byName.set(name, entity);
  }
  const resources = Object.keys(database);
  for (const entity of model.entities)
    for (const field of Object.values(entity.fields)) {
      if (field.mixed || field.system) continue;
      const relation = getRelationMetadata(childName(field), resources, entity.collection);
      if (!relation) continue;
      const target = defined(model.byCollection.get(relation.targetResource), relation.targetResource);
      const prefix = field.path.includes('.') ? field.path.slice(0, field.path.lastIndexOf('.') + 1) : '';
      const path = prefix + relation.relationName;
      if (!entity.fields[path]) {
        const node = addField(entity, path, { type: target.name + (relation.isMany ? '[]' : ''), source: field.path, target: 'id' });
        linkRelation(node, target, field.path, 'id');
      }
      if (!target.fields[relation.reverseRelationName]) {
        const reverse = addField(target, relation.reverseRelationName, { type: `${entity.name}[]`, source: 'id', target: field.path });
        linkRelation(reverse, entity, 'id', field.path);
      }
    }
  markRelationKeys(model);
  return model;
}
