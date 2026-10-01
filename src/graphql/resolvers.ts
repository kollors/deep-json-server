import { defaultFieldResolver, type FieldNode, type GraphQLFieldResolver, type GraphQLResolveInfo, type GraphQLSchema, getNamedType, isEnumType, isObjectType, isScalarType } from 'graphql';
import type { Engine, PreparedList } from '../core/engine.js';
import type { Actor } from '../core/lifecycle/options.js';
import type { Entity, Node } from '../core/model.js';
import type { MutationMode } from '../core/operations.js';
import { QueryBudget } from '../core/query/budget.js';
import type { ListOptions } from '../core/query/options.js';
import { type Context, isRef, type Ref, resolveField } from '../core/records.js';
import { defined } from '../core/utils.js';
import { preflight, selectionWidth } from './preflight.js';

// GraphQL shares introspection types across schemas, so their resolvers must be wrapped only once.
const budgetedResolvers = new WeakSet<GraphQLFieldResolver<unknown, GraphqlContext>>();

export interface GraphqlContext {
  budget: QueryBudget;
  actor?: () => Actor;
  snapshot(): Promise<Context>;
  prepare(info: GraphQLResolveInfo): Promise<Map<FieldNode, PreparedList>>;
  width(info: GraphQLResolveInfo): number;
}
/** Создаёт кеш снимка данных и проверки аргументов на время одного запроса.
 * @example Повторные вызовы context.snapshot() возвращают тот же Promise<Context>.
 */
export function createGraphqlContext(engine: Engine): GraphqlContext {
  const budget = new QueryBudget();
  let snapshot: Promise<Context> | undefined;
  let prepared: Promise<Map<FieldNode, PreparedList>> | undefined;
  const widths = new Map<FieldNode, number>();
  return {
    budget,
    snapshot: () =>
      (snapshot ??= engine.context().then((context) => {
        context.budget = budget;
        return context;
      })),
    prepare: (info) => (prepared ??= Promise.resolve().then(() => preflight(info, engine, budget))),
    width: (info) => {
      const field = defined(info.fieldNodes[0], 'GraphQL field');
      let width = widths.get(field);
      if (width === undefined) {
        width = selectionWidth(info);
        widths.set(field, width);
      }
      return width;
    },
  };
}
/** Назначает полям схемы обработчики чтения и изменения записей; изменяет переданную схему.
 * @example После вызова поле запроса имеет resolve; возвращаемое значение → undefined.
 */
export function attachResolvers(schema: GraphQLSchema, engine: Engine): void {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      const { entity, operation, node, listNode, keyArgument } = field.extensions as {
        entity?: Entity;
        operation?: MutationMode | 'find' | 'list';
        node?: Node;
        listNode?: Node;
        keyArgument?: string;
      };
      if (entity && operation)
        field.resolve = async (_root: unknown, args: ListOptions & Record<string, unknown>, context: GraphqlContext, info) => {
          const plans = await context.prepare(info);
          if (operation === 'find') {
            context.actor?.();
            return engine.find(await context.snapshot(), entity, args[entity.primary]) ?? null;
          }
          if (operation === 'list') {
            context.actor?.();
            return engine.list(engine.records(await context.snapshot(), entity), entity.root, args, plans.get(defined(info.fieldNodes[0], 'GraphQL field')), context.budget);
          }
          return engine.mutate(entity, operation, args[keyArgument ?? entity.primary], args.data ?? {}, undefined, context.actor);
        };
      else if (node)
        field.resolve = async (ref: Ref, args: ListOptions, context: GraphqlContext, info) => {
          const value = resolveField(ref, node, false, node.virtual ? context.actor?.() : undefined);
          if (!listNode || value == null) return value;
          const plans = await context.prepare(info);
          if (!Array.isArray(value) || !value.every(isRef)) throw new Error('Expected a list of record references');
          return engine.list(value, listNode, args, plans.get(defined(info.fieldNodes[0], 'GraphQL field')), context.budget);
        };
      const resolve = field.resolve ?? defaultFieldResolver;
      if (budgetedResolvers.has(resolve)) continue;
      const namedType = getNamedType(field.type);
      field.resolve = async (root: unknown, args: Record<string, unknown>, context: GraphqlContext, info) => {
        context.budget.field(String(info.path.key));
        await context.prepare(info);
        const value = await resolve(root, args, context, info);
        if (value != null && isObjectType(namedType)) context.budget.consume((Array.isArray(value) ? value.length : 1) * context.width(info));
        if (isRef(value)) {
          value.context.budget = context.budget;
          context.budget.record();
        } else if (Array.isArray(value) && value.every(isRef)) context.budget.record(value.length);
        else if (isScalarType(namedType) || isEnumType(namedType)) context.budget.scalar(value);
        return value;
      };
      budgetedResolvers.add(field.resolve);
    }
  }
}
