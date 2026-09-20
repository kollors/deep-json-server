import type { FastifyInstance } from 'fastify';
import type { Engine } from '../core/engine.js';
import { domainError } from '../core/errors.js';
import type { Authenticate } from '../core/lifecycle/options.js';
import type { Entity } from '../core/model.js';
import { MUTATIONS } from '../core/operations.js';
import { parseRestOptions } from './options.js';
import { listScope, project, validateRest } from './projection.js';

/** Возвращает актуальную сущность из снимка модели или сообщает об исчезнувшем ресурсе.
 * @example Коллекция users есть в модели → Entity; отсутствует → NOT_FOUND.
 */
function entityFor(engine: Engine, collection: string): Entity {
  const entity = engine.model.byCollection.get(collection);
  if (!entity) throw domainError('NOT_FOUND', 'Resource not found');
  return entity;
}
/** Регистрирует чтение коллекций и операции создания, замены, изменения и удаления записей.
 * @example После регистрации GET / → { resources: [...] }; функция возвращает undefined.
 */
export function registerRestRoutes(server: FastifyInstance, engine: Engine, authenticate?: Authenticate): void {
  server.get('/', async () => ({ resources: engine.model.entities.map((entity) => entity.collection) }));
  for (const initial of engine.model.entities) {
    const path = `/${initial.collection}`;
    const itemPath = `${path}/:${initial.primary}`;
    server.get(path, async (request) => {
      const actor = authenticate && request.headers.authorization !== undefined ? authenticate(request.headers.authorization) : undefined;
      const context = await engine.context();
      const entity = entityFor(engine, initial.collection);
      const options = parseRestOptions(request.query);
      const { scope, plans } = validateRest(engine, entity, options, true);
      const page = listScope(engine, engine.records(context, entity), entity.root, scope, plans);
      return { data: page.data.map((entry) => project(engine, entry.ref, entry.scope, plans, actor)), total: page.total };
    });
    server.get(itemPath, async (request) => {
      const actor = authenticate && request.headers.authorization !== undefined ? authenticate(request.headers.authorization) : undefined;
      const context = await engine.context();
      const entity = entityFor(engine, initial.collection);
      const options = parseRestOptions(request.query);
      const { scope, plans } = validateRest(engine, entity, options);
      const ref = engine.find(context, entity, (request.params as Record<string, string>)[entity.primary]);
      if (!ref) throw domainError('NOT_FOUND', 'Record not found');
      return project(engine, ref, scope, plans, actor);
    });
    for (const { method, mode, hasKey, status } of MUTATIONS) {
      server.route({
        method,
        url: hasKey ? itemPath : path,
        handler: async (request, reply) => {
          const actor = authenticate ? () => authenticate(request.headers.authorization) : undefined;
          actor?.();
          const options = parseRestOptions(request.query);
          const result = await engine.mutate(
            initial,
            mode,
            (request.params as Record<string, string>)[initial.primary],
            request.body,
            (ref) => {
              const { scope, plans } = validateRest(engine, ref.entity, options);
              return project(engine, ref, scope, plans, actor?.());
            },
            actor,
          );
          return reply.code(status).send(result);
        },
      });
    }
  }
}
