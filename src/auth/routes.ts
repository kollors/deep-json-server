import type { FastifyInstance } from 'fastify';
import { AUTH_PATHS } from './contract.js';
import type { AuthService } from './service.js';

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
