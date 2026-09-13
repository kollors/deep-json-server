import type { FastifyInstance } from 'fastify';
import type { Engine } from '../core/engine.js';
import { domainError } from '../core/errors.js';
import type { Authenticate } from '../core/lifecycle/options.js';
import { parseRestOptions } from './options.js';
import { project, validateRest } from './projection.js';
/** Регистрирует чтение коллекций и операции создания, замены, изменения и удаления записей.
 * @example После регистрации GET / → { resources: [...] }; функция возвращает undefined.
 */
export function registerRestRoutes(server: FastifyInstance, engine: Engine, authenticate?: Authenticate): void {
  server.get('/', async () => ({ resources: engine.model.entities.map((entity) => entity.collection) }));
  for (const initial of engine.model.entities) {
    const path = `/${initial.collection}`;
    const itemPath = `${path}/:${initial.primary}`;
    server.get(path, async (request) => {
      const context = await engine.context();
      const entity = context.model.byCollection.get(initial.collection)!;
      const options = parseRestOptions(request.query);
      const plans = validateRest(engine, entity, options, true);
      const page = engine.list(engine.records(context, entity), entity.root, undefined, plans.get(options.scope));
      return { data: page.data.map((ref) => project(engine, ref, options.scope, plans)), total: page.total };
    });
    server.get(itemPath, async (request) => {
      const context = await engine.context();
      const entity = context.model.byCollection.get(initial.collection)!;
      const options = parseRestOptions(request.query);
      const plans = validateRest(engine, entity, options);
      const ref = engine.find(context, entity, (request.params as Record<string, string>)[entity.primary]);
      if (!ref) throw domainError('NOT_FOUND', 'Record not found');
      return project(engine, ref, options.scope, plans);
    });
    for (const [method, mode] of [
      ['POST', 'create'],
      ['PUT', 'replace'],
      ['PATCH', 'update'],
      ['DELETE', 'delete'],
    ] as const) {
      server.route({
        method,
        url: mode === 'create' ? path : itemPath,
        handler: async (request, reply) => {
          const actor = authenticate?.(request.headers.authorization);
          const options = parseRestOptions(request.query);
          const result = await engine.mutate(
            initial,
            mode,
            (request.params as Record<string, string>)[initial.primary],
            request.body,
            (ref) => {
              const plans = validateRest(engine, ref.entity, options);
              return project(engine, ref, options.scope, plans);
            },
            actor,
          );
          return reply.code(mode === 'create' ? 201 : 200).send(result);
        },
      });
    }
  }
}
