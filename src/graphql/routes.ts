import type { FastifyInstance } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import type { Context, Engine } from '../engine.js';
import { DomainError } from '../errors.js';
export function registerGraphqlRoutes(server: FastifyInstance, schema: GraphQLSchema, engine: Engine, path: string): void {
  server.register(mercurius, {
    schema,
    path,
    queryDepth: 32,
    context: () => {
      let snapshot: Promise<Context> | undefined;
      return { snapshot: () => (snapshot ??= engine.context()) };
    },
    errorFormatter: (execution, context) => {
      const formatted = mercurius.defaultErrorFormatter(execution, context);
      formatted.response.errors = execution.errors.map((error) => {
        const original = error.originalError;
        if (original instanceof DomainError) return { ...error.toJSON(), extensions: { ...error.extensions, code: original.code } };
        if (original && !('errors' in original) && !(original instanceof Error && original.name === 'GraphQLError')) {
          context.reply?.request.log.error(original);
          return { message: 'Internal server error', locations: error.locations, path: error.path, extensions: { code: 'INTERNAL_ERROR' } };
        }
        return error.toJSON();
      });
      return formatted;
    },
  });
}
