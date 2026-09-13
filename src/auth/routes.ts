import type { FastifyInstance } from 'fastify';
import { AUTH_PATHS } from './contract.js';
import type { AuthService } from './service.js';

/** Регистрирует управление учётными записями и сессиями, запрещая кеширование ответов.
 * @example После регистрации ответы содержат Cache-Control: no-store; функция возвращает undefined.
 */
export function registerAuthRoutes(server: FastifyInstance, auth: AuthService): void {
  server.register(async (app) => {
    app.addHook('onRequest', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
    });
    app.post(AUTH_PATHS.login, async (request) => auth.login(request.body));
    app.post(AUTH_PATHS.register, async (request, reply) => reply.code(201).send(await auth.register(request.body)));
    app.get(AUTH_PATHS.me, async (request) => auth.me(request.headers.authorization));
    app.post(AUTH_PATHS.logout, async (request) => auth.logout(request.headers.authorization));
    app.patch<{ Params: { id: string } }>(AUTH_PATHS.password, async (request) => auth.changePassword(request.headers.authorization, request.params.id, request.body));
    app.patch<{ Params: { id: string } }>(AUTH_PATHS.admin, async (request) => auth.changeAdmin(request.headers.authorization, request.params.id, request.body));
  });
}
