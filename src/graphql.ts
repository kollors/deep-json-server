import {
  assertValidSchema,
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLSchema,
  GraphQLString,
} from 'graphql';
import { assertApi, type Entity, type InputMode, type Model, type Node, nodeName, operationName, writable } from './model.js';
import { operatorsFor } from './query/contract.js';
import { sortableFields } from './query/options.js';

export function buildGraphql(model: Model): GraphQLSchema {
  assertApi(model, 'graphql');
  const names = new Set(['String', 'Float', 'Int', 'Boolean', 'ID', 'Query', 'Mutation', 'Pager', 'OrderDirection']);
  const reserve = (name: string): string => {
    if (names.has(name)) throw new Error(`GraphQL type name collision: ${name}`);
    names.add(name);
    return name;
  };
  const objects = new Map<Node, GraphQLObjectType>();
  const pages = new Map<Node, GraphQLObjectType>();
  const inputs = new Map<Node, Map<string, GraphQLInputObjectType>>();
  const wheres = new Map<Node, GraphQLInputObjectType>();
  const filters = new Map<Node, GraphQLInputObjectType>();
  const orders = new Map<Node, GraphQLInputObjectType>();
  const enums = new Map<Node, GraphQLEnumType>();
  const pager = new GraphQLInputObjectType({ name: 'Pager', fields: { page: { type: GraphQLInt }, pageSize: { type: GraphQLInt } } });
  const direction = new GraphQLEnumType({ name: 'OrderDirection', values: { ASC: { value: 'ASC' }, DESC: { value: 'DESC' } } });
  const canonical = (entity: Entity, node: Node): [Entity, Node] => (node.relation ? [node.relation, node.relation.root] : [entity, node]);
  function scalar(entity: Entity, node: Node, constrained = true): GraphQLInputType & GraphQLOutputType {
    if (constrained && node.enum) {
      let type = enums.get(node);
      if (!type) {
        const values = Object.fromEntries(
          node.enum.map((value, index) => [typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(value) && !['true', 'false', 'null'].includes(value) ? value : `VALUE_${index}`, { value }]),
        );
        if (Object.keys(values).length !== node.enum.length) throw new Error(`Enum name collision: ${entity.name}.${node.path}`);
        type = new GraphQLEnumType({ name: reserve(`${nodeName(entity, node)}Enum`), values });
        enums.set(node, type);
      }
      return type;
    }
    return node.base === 'number' ? GraphQLFloat : node.base === 'boolean' ? GraphQLBoolean : node.primary ? GraphQLID : GraphQLString;
  }
  function output(entity: Entity, node: Node): GraphQLObjectType {
    [entity, node] = canonical(entity, node);
    let type = objects.get(node);
    if (type) return type;
    if (!Object.values(node.children).some((child) => !child.writeOnly)) throw new Error(`GraphQL object ${nodeName(entity, node)} must contain at least one visible field`);
    type = new GraphQLObjectType({
      name: reserve(nodeName(entity, node)),
      fields: () =>
        Object.fromEntries(
          Object.entries(node.children)
            .filter(([, child]) => !child.writeOnly)
            .map(([key, child]) => {
              const object = child.relation || child.base === 'object';
              let childType: GraphQLOutputType = object ? (child.many ? page(entity, child) : output(entity, child)) : scalar(entity, child);
              if (child.many && !object) childType = new GraphQLList(new GraphQLNonNull(childType));
              if (child.required && !child.nullable) childType = new GraphQLNonNull(childType);
              return [
                key,
                {
                  type: childType,
                  description: child.description,
                  extensions: { node: child, ...(object && child.many ? { listNode: child } : {}) },
                  args: object && child.many ? listArgs(entity, child) : undefined,
                },
              ];
            }),
        ),
    });
    objects.set(node, type);
    return type;
  }
  function page(entity: Entity, node: Node): GraphQLObjectType {
    [entity, node] = canonical(entity, node);
    let type = pages.get(node);
    if (type) return type;
    type = new GraphQLObjectType({
      name: reserve(`${nodeName(entity, node)}Page`),
      fields: () => ({ data: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(output(entity, node)))) }, total: { type: new GraphQLNonNull(GraphQLInt) } }),
    });
    pages.set(node, type);
    return type;
  }
  function input(entity: Entity, node: Node, mode: InputMode, root = false, nested = false): GraphQLInputObjectType {
    const name = `${nodeName(entity, node)}${nested ? 'Nested' : ''}${mode[0].toUpperCase() + mode.slice(1)}`;
    const variant = `${mode}:${root}:${nested}`;
    let variants = inputs.get(node);
    if (!variants) {
      variants = new Map();
      inputs.set(node, variants);
    }
    let type = variants.get(variant);
    if (type) return type;
    type = new GraphQLInputObjectType({
      name: reserve(name),
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {};
        for (const [key, child] of Object.entries(node.children)) {
          const lookup = nested && child.primary;
          if (!lookup && !writable(child, mode, true)) continue;
          let childType: GraphQLInputType = child.relation
            ? input(child.relation, child.relation.root, mode, true, true)
            : child.base === 'object'
              ? input(entity, child, mode)
              : scalar(entity, child);
          if (child.many) childType = new GraphQLList(new GraphQLNonNull(childType));
          if (!lookup && !child.relation && !child.relationKey && child.required && !child.nullable && !(root && (mode === 'update' || (nested && mode === 'create'))) && child.default === undefined)
            childType = new GraphQLNonNull(childType);
          fields[key] = { type: childType, description: child.description };
        }
        return fields;
      },
    });
    variants.set(variant, type);
    return type;
  }
  function where(entity: Entity, node: Node): GraphQLInputObjectType {
    [entity, node] = canonical(entity, node);
    let type = wheres.get(node);
    if (type) return type;
    const name = reserve(`${nodeName(entity, node)}Where`);
    type = new GraphQLInputObjectType({
      name,
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {
          and: { type: new GraphQLList(new GraphQLNonNull(type as GraphQLInputObjectType)) },
          or: { type: new GraphQLList(new GraphQLNonNull(type as GraphQLInputObjectType)) },
          not: { type: type as GraphQLInputObjectType },
        };
        for (const [key, child] of Object.entries(node.children))
          if (!child.writeOnly) {
            if (Object.hasOwn(fields, key)) throw new Error(`Reserved filter field: ${entity.name}.${child.path}`);
            fields[key] = { type: child.many ? filter(entity, child) : child.relation || child.base === 'object' ? where(entity, child) : filter(entity, child) };
          }
        return fields;
      },
    });
    wheres.set(node, type);
    return type;
  }
  function filter(entity: Entity, node: Node): GraphQLInputObjectType {
    let type = filters.get(node);
    if (type) return type;
    type = new GraphQLInputObjectType({
      name: reserve(`${nodeName(entity, node)}Filter`),
      fields: () => {
        const fields: GraphQLInputFieldConfigMap = {};
        const element = node.many ? (node.relation || node.base === 'object' ? where(entity, node) : filter(entity, { ...node, many: false, path: `${node.path}_element` })) : undefined;
        for (const [key, operand] of Object.entries(operatorsFor(node))) {
          const value = scalar(entity, node);
          if (operand === 'condition') fields[key] = { type: type as GraphQLInputObjectType };
          else if (operand === 'element') fields[key] = { type: element! };
          else fields[key] = { type: operand === 'values' ? new GraphQLList(value) : operand === 'comparison' ? scalar(entity, node, false) : operand === 'text' ? GraphQLString : value };
        }
        return fields;
      },
    });
    filters.set(node, type);
    return type;
  }
  function order(entity: Entity, node: Node): GraphQLInputObjectType | undefined {
    [entity, node] = canonical(entity, node);
    let type = orders.get(node);
    if (type) return type;
    const paths = sortableFields(node);
    if (!paths.length) return undefined;
    const values = Object.fromEntries(paths.map((path) => [path.replaceAll('.', '_'), { value: path }]));
    if (Object.keys(values).length !== paths.length) throw new Error(`Sort enum collision: ${nodeName(entity, node)}`);
    const field = new GraphQLEnumType({ name: reserve(`${nodeName(entity, node)}OrderField`), values });
    type = new GraphQLInputObjectType({ name: reserve(`${nodeName(entity, node)}Order`), fields: { field: { type: new GraphQLNonNull(field) }, direction: { type: new GraphQLNonNull(direction) } } });
    orders.set(node, type);
    return type;
  }
  function listArgs(entity: Entity, node: Node) {
    const ordering = order(entity, node);
    return { where: { type: where(entity, node) }, pager: { type: pager }, ...(ordering ? { order: { type: new GraphQLList(new GraphQLNonNull(ordering)) } } : {}) };
  }
  const queries: GraphQLFieldConfigMap<unknown, unknown> = {};
  const mutations: GraphQLFieldConfigMap<unknown, unknown> = {};
  for (const entity of model.entities.filter((e) => e.api.includes('graphql'))) {
    const name = operationName(entity);
    for (const operation of [name, `${name}List`]) if (queries[operation]) throw new Error(`GraphQL operation collision: ${operation}`);
    const keyArg = { [entity.primary]: { type: new GraphQLNonNull(scalar(entity, entity.fields[entity.primary], false)) } };
    queries[name] = {
      type: output(entity, entity.root),
      args: keyArg,
      extensions: { entity, operation: 'find' },
    };
    queries[`${name}List`] = {
      type: new GraphQLNonNull(page(entity, entity.root)),
      args: listArgs(entity, entity.root),
      extensions: { listNode: entity.root, entity, operation: 'list' },
    };
    for (const mode of ['create', 'replace', 'update', 'delete'] as const) {
      const operation = `${name}${mode[0].toUpperCase() + mode.slice(1)}`;
      if (mutations[operation]) throw new Error(`GraphQL operation collision: ${operation}`);
      const fields = Object.values(entity.root.children).filter((child) => writable(child, mode === 'delete' ? 'update' : mode, true));
      mutations[operation] = {
        type: output(entity, entity.root),
        args: { ...(mode !== 'create' ? keyArg : {}), ...(mode !== 'delete' && fields.length ? { data: { type: new GraphQLNonNull(input(entity, entity.root, mode, true)) } } : {}) },
        extensions: { entity, operation: mode },
      };
    }
  }
  if (!Object.keys(queries).length) throw new Error('No models enable graphql');
  const schema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'Query', fields: queries }), mutation: new GraphQLObjectType({ name: 'Mutation', fields: mutations }) });
  assertValidSchema(schema);
  return schema;
}
