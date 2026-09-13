import { AUTH_PATHS, MAX_PASSWORD_LENGTH, MAX_USERNAME_LENGTH } from '../auth/contract.js';
import { json, ref, response } from './helpers.js';
import type { OpenapiDocument, OpenapiSchema } from './types.js';

const password: OpenapiSchema = { type: 'string', format: 'password', writeOnly: true, minLength: 1, maxLength: MAX_PASSWORD_LENGTH };
export const AUTH_SCHEMAS: Record<string, OpenapiSchema> = {
  AuthUser: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'username', 'isAdmin'],
    properties: { id: { type: 'string' }, username: { type: 'string' }, isAdmin: { type: 'boolean' } },
  },
  AuthCredentialsInput: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'password'],
    properties: {
      username: { type: 'string', minLength: 1, maxLength: MAX_USERNAME_LENGTH, pattern: '\\S' },
      password,
    },
  },
  AuthPasswordInput: {
    type: 'object',
    additionalProperties: false,
    required: ['newPassword'],
    properties: { currentPassword: { ...password, description: 'Required when changing your own password, including administrators.' }, newPassword: password },
  },
  AuthAdminInput: {
    type: 'object',
    additionalProperties: false,
    required: ['isAdmin'],
    properties: { isAdmin: { type: 'boolean' } },
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
  AuthSuccess: { type: 'object', additionalProperties: false, required: ['success'], properties: { success: { type: 'boolean' } } },
};
export const AUTH_SECURITY_SCHEMES = {
  AuthBearer: {
    type: 'http',
    scheme: 'bearer',
    description: 'Session token returned by POST /auth/login. Required for record mutations and protected auth routes. Login and registration are public.',
  },
};
/** Создаёт описания управления учётными записями и сессиями с требованиями доступа.
 * @example authOpenapiPaths() → маршруты входа, регистрации, выхода, текущего пользователя, смены пароля и статуса.
 */
export function authOpenapiPaths(): OpenapiDocument['paths'] {
  const unauthorized = response('Invalid credentials or expired session', ref('Error'));
  const invalid = response('Invalid input', ref('Error'));
  const forbidden = response('Insufficient permissions', ref('Error'));
  const missing = response('Auth user not found', ref('Error'));
  const busy = response('Too many simultaneous password operations or sessions', ref('Error'));
  const writeFailed = response('Failed to save auth users; changes were not applied', ref('Error'));
  const userId = { in: 'path', name: 'id', required: true, schema: { type: 'string', minLength: 1 } };
  return {
    [AUTH_PATHS.login]: {
      post: {
        operationId: 'authLogin',
        tags: ['auth'],
        security: [],
        requestBody: { required: true, ...json(ref('AuthCredentialsInput')) },
        responses: { 200: response('Session created', ref('AuthSession')), 400: invalid, 401: unauthorized, 429: busy },
      },
    },
    [AUTH_PATHS.register]: {
      post: {
        operationId: 'authRegister',
        tags: ['auth'],
        security: [],
        description: 'Creates a user with a generated id and isAdmin: false. Does not create a session; use login afterwards. Usernames are case-sensitive and unique.',
        requestBody: { required: true, ...json(ref('AuthCredentialsInput')) },
        responses: { 201: response('User created', ref('AuthUser')), 400: invalid, 409: response('Username already exists', ref('Error')), 429: busy, 500: writeFailed },
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
        responses: { 200: response('Session revoked', ref('AuthSuccess')), 401: unauthorized },
      },
    },
    [AUTH_PATHS.password.replace(':id', '{id}')]: {
      patch: {
        operationId: 'authChangePassword',
        tags: ['auth'],
        security: [{ AuthBearer: [] }],
        parameters: [userId],
        description:
          'Users, including administrators, supply currentPassword to change their own password. Administrators may reset ordinary users passwords without currentPassword, but cannot change another administrator password. Success revokes all sessions of the target user.',
        requestBody: { required: true, ...json(ref('AuthPasswordInput')) },
        responses: {
          200: response('Password changed; user sessions revoked', ref('AuthSuccess')),
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: missing,
          409: response('Password changed during the request', ref('Error')),
          429: busy,
          500: writeFailed,
        },
      },
    },
    [AUTH_PATHS.admin.replace(':id', '{id}')]: {
      patch: {
        operationId: 'authChangeAdmin',
        tags: ['auth'],
        security: [{ AuthBearer: [] }],
        parameters: [userId],
        description:
          'Only administrators may change isAdmin. The last administrator cannot remove their own status. Existing sessions use the new permissions immediately. An administrator may demote another administrator and then reset their password as an ordinary user.',
        requestBody: { required: true, ...json(ref('AuthAdminInput')) },
        responses: {
          200: response('Admin status updated', ref('AuthUser')),
          400: invalid,
          401: unauthorized,
          403: forbidden,
          404: missing,
          409: response('Cannot remove the last administrator', ref('Error')),
          500: writeFailed,
        },
      },
    },
  };
}
