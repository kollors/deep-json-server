import { type FieldNode, type GraphQLResolveInfo, type GraphQLSchema, isObjectType } from 'graphql';
import type { Engine, PreparedList } from '../core/engine.js';
import type { Actor } from '../core/lifecycle/options.js';
import type { Entity, InputMode, Node } from '../core/model.js';
import type { ListOptions } from '../core/query/options.js';
import { type Context, type Ref, resolveField } from '../core/records.js';
import { preflight } from './preflight.js';

export interface GraphqlContext {
  actor?: () => Actor;
  snapshot(): Promise<Context>;
  prepare(info: GraphQLResolveInfo): Promise<Map<FieldNode, PreparedList>>;
}
/** Создаёт кеш снимка данных и проверки аргументов на время одного запроса.
 * @example Повторные вызовы context.snapshot() возвращают тот же Promise<Context>.
 */
export function createGraphqlContext(engine: Engine): GraphqlContext {
  let snapshot: Promise<Context> | undefined;
  let prepared: Promise<Map<FieldNode, PreparedList>> | undefined;
  return {
    snapshot: () => (snapshot ??= engine.context()),
    prepare: (info) => (prepared ??= Promise.resolve().then(() => preflight(info, engine))),
  };
}
/** Назначает полям схемы обработчики чтения и изменения записей; изменяет переданную схему.
 * @example После вызова поле запроса имеет resolve; возвращаемое значение → undefined.
 */
export function attachResolvers(schema: GraphQLSchema, engine: Engine): void {
  for (const type of Object.values(schema.getTypeMap())) {
    if (!isObjectType(type)) continue;
    for (const field of Object.values(type.getFields())) {
      const { entity, operation, node, listNode } = field.extensions as { entity?: Entity; operation?: InputMode | 'delete' | 'find' | 'list'; node?: Node; listNode?: Node };
      if (entity && operation)
        field.resolve = async (_root, args, context: GraphqlContext, info) => {
          const plans = await context.prepare(info);
          if (operation === 'find') return engine.find(await context.snapshot(), entity, args[entity.primary]) ?? null;
          if (operation === 'list') return engine.list(engine.records(await context.snapshot(), entity), entity.root, args, plans.get(info.fieldNodes[0]));
          return engine.mutate(entity, operation as 'create' | 'replace' | 'update' | 'delete', args[entity.primary], args.data ?? {}, undefined, context.actor?.());
        };
      else if (node)
        field.resolve = async (ref: Ref, args: ListOptions, context: GraphqlContext, info) => {
          const value = resolveField(ref, node);
          if (!listNode || value == null) return value;
          const plans = await context.prepare(info);
          return engine.list(value as Ref[], listNode, args, plans.get(info.fieldNodes[0]));
        };
    }
  }
}
