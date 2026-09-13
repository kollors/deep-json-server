import { DEFAULT_HOST, DEFAULT_PORT } from './constants.js';
import { isObject, isPortNumber } from './utils.js';

/** Проверяет объект и обязательность значения; необязательные null и undefined пропускает.
 * @example getObject(undefined, 'data') → undefined; getObject([], 'data', true) → ошибка.
 */
export function getObject(value: unknown, path: string, required: true): Record<string, unknown>;
export function getObject(value: unknown, path: string, required?: false): Record<string, unknown> | undefined;
export function getObject(value: unknown, path: string, required = false): Record<string, unknown> | undefined {
  if (value == null && !required) {
    return undefined;
  }

  if (!isObject(value)) {
    throw new Error(`Ключ ${path} должен быть JSON-объектом`);
  }

  return value;
}

/** Проверяет непустую строку, не обрезая её; необязательные null и undefined пропускает.
 * @example getString(' a ', 'name') → ' a '; getString('', 'name') → ошибка.
 */
export function getString(value: unknown, path: string, required: true): string;
export function getString(value: unknown, path: string, required?: false): string | undefined;
export function getString(value: unknown, path: string, required = false): string | undefined {
  if (value == null && !required) {
    return undefined;
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Ключ ${path} должен содержать непустую строку`);
  }

  return value;
}

/** Принимает положительное безопасное целое число или отсутствие значения.
 * @example getPositiveInteger(2, 'size') → 2; getPositiveInteger(0, 'size') → ошибка.
 */
export const getPositiveInteger = (value: unknown, path: string): number | undefined => {
  if (value == null) {
    return undefined;
  }

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Ключ ${path} должен быть положительным целым числом`);
  }

  return value;
};

/** Проверяет необязательный логический флаг, не преобразуя строки в boolean.
 * @example getBoolean(false, 'flag') → false; getBoolean('false', 'flag') → ошибка.
 */
export function getBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${path} must be boolean`);
  return value;
}
/** Проверяет адрес и порт и подставляет значения по умолчанию.
 * @example normalizeAddress({ port: 0 }) → { host: '127.0.0.1', port: 0 }.
 */
export function normalizeAddress(options: { host?: unknown; port?: unknown }): { host: string; port: number } {
  const host = getString(options.host, 'config.server.host') ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (!isPortNumber(port)) throw new Error('Ключ config.server.port должен быть целым числом от 0 до 65535');
  return { host, port };
}
