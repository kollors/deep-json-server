import type { FastifyInstance, FastifyListenOptions, FastifyServerOptions } from 'fastify';
import { DomainError } from '../core/errors.js';
import { domainStatus } from '../core/http-errors.js';
import { errorMessage, isObject } from '../core/utils.js';

type ListenCallback = (error: Error | null, address: string) => void;

/** Создаёт HTTP-сервер с едиными ошибками, CORS и значениями listen по умолчанию.
 * @example createHttpServer({ create: Fastify, host: '127.0.0.1', port: 4001, logger: false, cors: false, corsHeaders: {} }) → FastifyInstance.
 */
export function createHttpServer({
  create,
  host,
  port,
  logger,
  cors,
  corsHeaders,
}: {
  create: typeof import('fastify').default;
  host: string;
  port: number;
  logger: FastifyServerOptions['logger'];
  cors: boolean;
  corsHeaders: Record<string, string>;
}): FastifyInstance {
  const server = create({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } }, logger });
  const originalListen = server.listen.bind(server);
  const defaults = { host, port };
  const listen = (optionsOrCallback?: FastifyListenOptions | ListenCallback, callback?: ListenCallback): Promise<string> | undefined => {
    if (typeof optionsOrCallback === 'function') {
      originalListen(defaults, optionsOrCallback);
      return;
    }
    const options = optionsOrCallback?.path === undefined ? { ...defaults, ...optionsOrCallback } : optionsOrCallback;
    if (callback) {
      originalListen(options, callback);
      return;
    }
    return originalListen(options);
  };
  server.listen = listen as FastifyInstance['listen'];
  server.setErrorHandler((error, request, reply) => {
    const candidate = error instanceof DomainError ? domainStatus[error.code] : isObject(error) ? error.statusCode : undefined;
    const status = typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
    if (status === 500) request.log.error(error);
    return reply.code(status).send({ error: status === 500 ? 'Internal server error' : errorMessage(error) });
  });
  if (cors) {
    server.addHook('onRequest', async (_request, reply) => {
      for (const [key, value] of Object.entries(corsHeaders)) reply.header(key, value);
    });
    server.options('/', async (_request, reply) => reply.code(204).send());
    server.options('/*', async (_request, reply) => reply.code(204).send());
  }
  return server;
}
