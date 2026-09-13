import type { FastifyInstance } from 'fastify';
import type { GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import type { Engine } from '../core/engine.js';
import { DomainError } from '../core/errors.js';
import type { Authenticate } from '../core/lifecycle/options.js';
import { attachResolvers, createGraphqlContext } from './resolvers.js';
/** Регистрирует обработчик GraphQL, контекст запроса и преобразование ошибок.
 * @example После регистрации POST на заданный path выполняет запрос; прикладная ошибка попадает в errors[].extensions.code.
 */
export function registerGraphqlRoutes(server: FastifyInstance, schema: GraphQLSchema, engine: Engine, path: string, authenticate?: Authenticate): void {
  attachResolvers(schema, engine);
  server.register(mercurius, {
    schema,
    path,
    queryDepth: 32,
    context: (request) => ({ ...createGraphqlContext(engine), ...(authenticate ? { actor: () => authenticate(request.headers.authorization) } : {}) }),
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
