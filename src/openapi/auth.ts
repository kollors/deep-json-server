import { AUTH_PATHS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from '../auth/contract.js';
import { json, ref, response } from './helpers.js';
import type { OpenapiDocument, OpenapiSchema } from './types.js';

export const AUTH_SCHEMAS: Record<string, OpenapiSchema> = {
  AuthUser: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'username', 'isAdmin'],
    properties: { id: { type: 'string' }, username: { type: 'string' }, isAdmin: { type: 'boolean' } },
  },
  AuthLoginInput: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1, maxLength: MAX_USERNAME_LENGTH },
      password: { type: 'string', format: 'password', writeOnly: true, minLength: 1, maxLength: MAX_PASSWORD_LENGTH },
    },
  },
  AuthSession: {
    type: 'object',
    additionalProperties: false,
    required: ['accessToken', 'expiresIn', 'user'],
    properties: {
      accessToken: { type: 'string' },
      expiresIn: { type: 'integer', minimum: 1 },
      user: ref('AuthUser'),
    },
  },
  AuthLogoutResult: { type: 'object', additionalProperties: false, required: ['success'], properties: { success: { type: 'boolean' } } },
};
export const AUTH_SECURITY_SCHEMES = {
  AuthBearer: { type: 'http', scheme: 'bearer', description: 'Session token returned by POST /auth/login. Required for record mutations, GET /auth/me and POST /auth/logout.' },
};
/** Создаёт описания маршрутов входа, выхода и текущего пользователя.
 * @example authOpenapiPaths() → объект с ключами '/auth/login', '/auth/logout', '/auth/me'.
 */
export function authOpenapiPaths(): OpenapiDocument['paths'] {
  const unauthorized = response('Invalid credentials or expired session', ref('Error'));
  return {
    [AUTH_PATHS.login]: {
      post: {
        operationId: 'authLogin',
        tags: ['auth'],
        security: [],
        requestBody: { required: true, ...json(ref('AuthLoginInput')) },
        responses: {
          200: response('Session created', ref('AuthSession')),
          400: response('Invalid input', ref('Error')),
          401: unauthorized,
          429: response('Too many login attempts or sessions', ref('Error')),
        },
      },
    },
    [AUTH_PATHS.me]: {
      get: {
        operationId: 'authMe',
        tags: ['auth'],
        security: [{ AuthBearer: [] }],
        responses: { 200: response('Current auth user', ref('AuthUser')), 401: unauthorized },
      },
    },
    [AUTH_PATHS.logout]: {
      post: {
        operationId: 'authLogout',
        tags: ['auth'],
        security: [{ AuthBearer: [] }],
        responses: { 200: response('Session revoked', ref('AuthLogoutResult')), 401: unauthorized },
      },
    },
  };
}
