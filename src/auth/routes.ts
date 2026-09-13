import type { FastifyInstance } from 'fastify';
import { AUTH_PATHS } from './contract.js';
import type { AuthService } from './service.js';

/** Регистрирует вход, выход и получение текущего пользователя, запрещая кеширование ответов.
 * @example После регистрации ответы содержат Cache-Control: no-store; функция возвращает undefined.
 */
export function registerAuthRoutes(server: FastifyInstance, auth: AuthService): void {
  server.register(async (app) => {
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    app.post(AUTH_PATHS.login, async (request) => auth.login(request.body));
    app.get(AUTH_PATHS.me, async (request) => auth.me(request.headers.authorization));
    app.post(AUTH_PATHS.logout, async (request) => auth.logout(request.headers.authorization));
  });
}
