import { domainError } from '../core/errors.js';
import { hasOnlyKeys, isObject } from '../core/utils.js';
import { MAX_USERNAME_LENGTH } from './contract.js';
import { validPassword } from './password.js';

/** Принимает только непустое имя и допустимый пароль без дополнительных полей.
 * @example { username: 'anna', password: 'secret' } → та же пара строк; дополнительный isAdmin → ошибка.
 */
export function credentials(body: unknown): { username: string; password: string } {
  if (
    !isObject(body) ||
    !hasOnlyKeys(body, ['username', 'password']) ||
    typeof body.username !== 'string' ||
    !body.username.trim() ||
    body.username.length > MAX_USERNAME_LENGTH ||
    !validPassword(body.password)
  )
    throw domainError('INVALID_INPUT', 'Supply username and password');
  return { username: body.username, password: body.password };
}

/** Проверяет новый пароль и необязательный текущий пароль; оба значения возвращает без преобразований.
 * @example { newPassword: 'next' } → { newPassword: 'next', currentPassword: undefined }; пустой пароль → ошибка.
 */
export function passwordChange(body: unknown): { newPassword: string; currentPassword?: string } {
  if (!isObject(body) || !hasOnlyKeys(body, ['currentPassword', 'newPassword']) || !validPassword(body.newPassword) || (body.currentPassword !== undefined && !validPassword(body.currentPassword)))
    throw domainError('INVALID_INPUT', 'Supply newPassword and an optional currentPassword');
  return { newPassword: body.newPassword, currentPassword: body.currentPassword as string | undefined };
}

/** Принимает единственный логический флаг без преобразования строк и чисел.
 * @example { isAdmin: false } → false; { isAdmin: 'false' } → ошибка.
 */
export function adminChange(body: unknown): boolean {
  if (!isObject(body) || !hasOnlyKeys(body, ['isAdmin']) || typeof body.isAdmin !== 'boolean') throw domainError('INVALID_INPUT', 'Supply a boolean isAdmin');
  return body.isAdmin;
}
