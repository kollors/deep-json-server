import type { FastifyInstance } from 'fastify';
import type { Engine } from '../engine.js';
import { domainError } from '../errors.js';
import { parseRestOptions } from './options.js';
import { project, validateRest } from './projection.js';
export function registerRestRoutes(server: FastifyInstance, engine: Engine): void {
  server.get('/', async () => ({ resources: engine.model.entities.map((entity) => entity.collection) }));
  for (const initial of engine.model.entities) {
    const path = `/${initial.collection}`;
    const itemPath = `${path}/:${initial.primary}`;
    server.get(path, async (request) => {
      const context = await engine.context();
      const entity = context.model.byCollection.get(initial.collection)!;
      const options = parseRestOptions(request.query, true);
      const plans = validateRest(engine, entity, options);
      const page = engine.list(engine.records(context, entity), entity.root, options);
      return { data: page.data.map((ref) => project(engine, ref, options.scope, options.nested, '', plans)), total: page.total };
    });
    server.get(itemPath, async (request) => {
      const context = await engine.context();
      const entity = context.model.byCollection.get(initial.collection)!;
      const options = parseRestOptions(request.query, false);
      const plans = validateRest(engine, entity, options);
      const ref = engine.find(context, entity, (request.params as Record<string, string>)[entity.primary]);
      if (!ref) throw domainError('NOT_FOUND', 'Record not found');
      return project(engine, ref, options.scope, options.nested, '', plans);
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
          const options = parseRestOptions(request.query, false);
          const result = await engine.mutate(initial, mode, (request.params as Record<string, string>)[initial.primary], request.body, (ref) => {
            const plans = validateRest(engine, ref.entity, options);
            return project(engine, ref, options.scope, options.nested, '', plans);
          });
          return reply.code(mode === 'create' ? 201 : 200).send(result);
        },
      });
    }
  }
}
