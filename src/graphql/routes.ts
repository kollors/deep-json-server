import type { FastifyInstance } from 'fastify';
import { GraphQLError, type GraphQLSchema } from 'graphql';
import mercurius from 'mercurius';
import type { Engine } from '../core/engine.js';
import { DomainError } from '../core/errors.js';
import type { Authenticate } from '../core/lifecycle/options.js';
import { QueryBudgetError } from '../core/query/budget.js';
import { selectionBudgetRule } from './preflight.js';
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
    validationRules: [selectionBudgetRule],
    context: (request) => ({
      ...createGraphqlContext(engine),
      ...(authenticate && request.headers.authorization !== undefined ? { actor: () => authenticate(request.headers.authorization) } : {}),
    }),
    errorFormatter: (execution, context) => {
      const budgetError = execution.errors
        .flatMap((error) => {
          const original = error.originalError;
          const nested = original && 'errors' in original ? original.errors : undefined;
          return Array.isArray(nested) ? [error, ...nested.filter((entry): entry is GraphQLError => entry instanceof GraphQLError)] : [error];
        })
        .find((error) => error.originalError instanceof QueryBudgetError);
      if (budgetError)
        return {
          statusCode: execution.errors.includes(budgetError) ? 200 : 400,
          response: { data: null, errors: [{ ...budgetError.toJSON(), extensions: { ...budgetError.extensions, code: 'INVALID_QUERY' } }] },
        };
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
